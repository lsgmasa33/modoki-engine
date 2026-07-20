/** MODULE-BOUNDARY GUARD (Phase 2c) — the PixiJS 2D text shader must not statically
 *  pull the Three node pipeline. `mtsdfPixiShader` (the 2D text path, reachable in a
 *  render3d-OFF build) once imported two spread constants + the `MtsdfStyle` type
 *  straight from `mtsdfShader` — which imports `three/webgpu` + `three/tsl`. That one
 *  value import dragged ALL of Three into a 2D-only game bundle (measured: ~289 KB of
 *  three/webgpu in the chess build). The fix moved the shared shape + constants into a
 *  three-FREE `mtsdfStyle.ts`.
 *
 *  This test walks the STATIC relative-import closure from the 2D text entry and fails
 *  if any module in it imports `three/webgpu` or `three/tsl` — so a future edit that
 *  re-couples the 2D text path to the Three shader is caught here, not in a bloated build. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const ENTRY = path.join(srcDir, 'runtime/rendering/text/mtsdfPixiShader.ts');

const FORBIDDEN = ['three/webgpu', 'three/tsl'];

/** Resolve a relative import specifier to an on-disk .ts/.tsx file (or null). */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** All import specifiers in a file — static `from '…'` / `import '…'` AND dynamic
 *  `import('…')`. `import type` is INCLUDED deliberately: a type-only import of a
 *  three module is erased and harmless, but a type-only import of a RELATIVE module
 *  is also erased, so following it would over-report. We only flag a FORBIDDEN bare
 *  specifier when it's a VALUE import, so strip `import type { … }` lines first. */
function importsOf(file: string): { relatives: string[]; bare: string[] } {
  const src = fs.readFileSync(file, 'utf8');
  const relatives: string[] = [];
  const bare: string[] = [];
  const re = /(?:^|\n)\s*(import\s+type\s+)?[^\n;]*?(?:from|import\()\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const isTypeOnly = Boolean(m[1]);
    const spec = m[2];
    if (spec.startsWith('.')) {
      if (!isTypeOnly) relatives.push(spec); // erased type imports don't carry runtime deps
    } else if (!isTypeOnly) {
      bare.push(spec);
    }
  }
  return { relatives, bare };
}

describe('2D MTSDF text path is Three-node-pipeline free (Phase 2c boundary)', () => {
  it(`static import closure from mtsdfPixiShader never reaches ${FORBIDDEN.join(' / ')}`, () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue = [ENTRY];
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const { relatives, bare } = importsOf(file);
      for (const b of bare) {
        if (FORBIDDEN.includes(b)) offenders.push(`${path.relative(srcDir, file)} → ${b}`);
      }
      for (const r of relatives) {
        const resolved = resolveRelative(file, r);
        if (resolved) queue.push(resolved);
      }
    }
    expect(
      offenders,
      `The PixiJS 2D text path must not statically import the Three node pipeline ` +
        `(it would drag three/webgpu into a 2D-only build). Route shared style/constants ` +
        `through the three-free mtsdfStyle.ts:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the shared style module (mtsdfStyle.ts) imports no Three at all', () => {
    const styleFile = path.join(srcDir, 'runtime/rendering/text/mtsdfStyle.ts');
    const { bare } = importsOf(styleFile);
    const three = bare.filter((b) => b === 'three' || b.startsWith('three/'));
    expect(three, `mtsdfStyle.ts must stay three-free so both text paths can share it`).toEqual([]);
  });
});
