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
import os from 'node:os';
import path from 'node:path';
import { walkClosure } from './importClosure';

/** A three-file chain: entry → mid → leaf, where only `leaf` reaches the forbidden specifier. */
let srcDir: string;

beforeAll(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-closure-'));
  fs.mkdirSync(path.join(srcDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'entry.ts'), "import { m } from './nested/mid';\nexport { m };\n");
  fs.writeFileSync(
    path.join(srcDir, 'nested', 'mid.ts'),
    "import { l } from './leaf';\nexport const m = l;\n",
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

  it('leaves an unrelated skipEdge inert — the allowlist must not silence the whole walk', () => {
    const { offenders } = walk([{ file: 'nested/mid.ts', spec: './not-the-edge' }]);
    expect(offenders).toHaveLength(1);
  });
});
