/** Unit cover for the shared import-closure walker.
 *
 *  The walker is guard INFRASTRUCTURE: `mtsdf2DBoundary` and `render3dBoundary` both trust its
 *  addresses, and a third guard is cheap to add. Its contract is therefore worth pinning directly
 *  rather than only through those two — especially the parts that fail SILENTLY.
 *
 *  Both assertions below exist because of a real Windows break (2026-08-20): `path.relative`
 *  returned `runtime\loaders\textureResolver.ts`, so `skipEdges` — keyed by the hand-authored
 *  POSIX `runtime/loaders/textureResolver.ts` — matched nothing, and `render3dBoundary` reported
 *  every GATED edge as an offender. That one failed loudly only because it independently pins
 *  non-vacuity; the general shape (collect offenders, assert empty) would have gone green on
 *  Windows with its matching switched off. See docs/windows.md § Paths. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walkClosure } from './importClosure';
import { makeScratchDir } from './scratchDir';

/** A three-file chain: entry → mid → leaf, where only `leaf` reaches the forbidden specifier. `entry`
 *  re-exports `mid` and `mid` imports `leaf` dynamically — the two edge kinds a line reader missed or
 *  had to regex separately. */
let srcDir: string;

beforeAll(() => {
  srcDir = makeScratchDir('import-closure-');
  fs.mkdirSync(path.join(srcDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'entry.ts'), "export { m } from './nested/mid';\n");
  fs.writeFileSync(
    path.join(srcDir, 'nested', 'mid.ts'),
    "export const m = () => import('./leaf');\n",
  );
  fs.writeFileSync(path.join(srcDir, 'nested', 'leaf.ts'), "import 'three/webgpu';\nexport const l = 1;\n");
});

afterAll(() => fs.rmSync(srcDir, { recursive: true, force: true }));

const walk = (skipEdges?: { file: string; spec: string }[]) =>
  walkClosure({ srcDir, entries: ['entry.ts'], forbidden: ['three/webgpu'], skipEdges });

describe('walkClosure', () => {
  it('reaches a forbidden specifier through a nested chain, and names the chain', () => {
    const { offenders, visited } = walk();
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('three/webgpu');
    expect(offenders[0]).toContain('entry.ts → nested/mid.ts → nested/leaf.ts');
    expect(visited).toHaveLength(3);
  });

  it('addresses every file in POSIX, on every platform', () => {
    // A `\` here is what silently unkeys `skipEdges` and any future allowlist built on `visited`.
    const { visited } = walk();
    expect(visited.filter((v) => v.includes('\\'))).toEqual([]);
    expect(visited).toContain('nested/leaf.ts');
  });

  it('honours a skipEdge addressed the way an allowlist writes it — POSIX, relative to srcDir', () => {
    // The edge is nested on BOTH sides precisely so a separator bug cannot pass by accident:
    // a single-segment address has no separator to get wrong.
    const { offenders } = walk([{ file: 'nested/mid.ts', spec: './leaf' }]);
    expect(offenders).toEqual([]);
  });

  it('skips only a DYNAMIC import at that address — a static import beside it is still followed (#1179)', () => {
    // A flag folds away the branch an import() sits in; nothing folds a static import. Keyed on the
    // address alone, this edge was skipped and its gate check (which reads only the import()) passed.
    const dir = makeScratchDir('import-closure-static-');
    fs.writeFileSync(path.join(dir, 'entry.ts'), "import './leaf';\nexport const lazy = () => import('./leaf');\n");
    fs.writeFileSync(path.join(dir, 'leaf.ts'), "import 'three/webgpu';\n");
    const { offenders } = walkClosure({ srcDir: dir, entries: ['entry.ts'], forbidden: ['three/webgpu'], skipEdges: [{ file: 'entry.ts', spec: './leaf' }] });
    expect(offenders).toHaveLength(1);
  });

  it('treats a non-script import as a leaf, and re-reads a file rewritten between walks (#1179 P4 review)', () => {
    const dir = makeScratchDir('import-closure-leaf-');
    fs.writeFileSync(path.join(dir, 'data.json'), '{ "a": 1 }\n');
    fs.writeFileSync(path.join(dir, 's.css'), 'a { b: c }\n');
    fs.writeFileSync(path.join(dir, 'i.svg'), '<svg/>\n');
    fs.writeFileSync(path.join(dir, 'entry.ts'), "import d from './data.json';\nimport './s.css';\nimport u from './i.svg';\nexport { d, u };\n");
    const walkDir = () => walkClosure({ srcDir: dir, entries: ['entry.ts'], forbidden: ['three/webgpu'] });
    expect(walkDir()).toEqual({ visited: ['entry.ts', 'data.json', 's.css', 'i.svg'], offenders: [] });
    // Same path, different content: the second walk must see the new edge — also when the rewrite keeps
    // the size and lands in the same mtime tick (forced here, since a fast disk does it by itself).
    const entry = path.join(dir, 'entry.ts');
    fs.writeFileSync(entry, "import './leaf-a';\n");
    fs.writeFileSync(path.join(dir, 'leaf-a.ts'), '');
    fs.writeFileSync(path.join(dir, 'leaf-b.ts'), "import 'three/webgpu';\n");
    const stamp = new Date(2026, 0, 1);
    fs.utimesSync(entry, stamp, stamp);
    expect(walkDir().offenders).toEqual([]);
    fs.writeFileSync(entry, "import './leaf-b';\n");
    fs.utimesSync(entry, stamp, stamp);
    expect(walkDir().offenders).toHaveLength(1);
  });

  it('leaves an unrelated skipEdge inert — the allowlist must not silence the whole walk', () => {
    const { offenders } = walk([{ file: 'nested/mid.ts', spec: './not-the-edge' }]);
    expect(offenders).toHaveLength(1);
  });
});
