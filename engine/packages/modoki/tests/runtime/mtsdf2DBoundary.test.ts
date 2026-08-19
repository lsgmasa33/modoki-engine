/** MODULE-BOUNDARY GUARD (Phase 2c) — the PixiJS 2D text shader must not statically
 *  pull the Three node pipeline. `mtsdfPixiShader` (the 2D text path, reachable in a
 *  render3d-OFF build) once imported two spread constants + the `MtsdfStyle` type
 *  straight from `mtsdfShader` — which imports `three/webgpu` + `three/tsl`. That one
 *  value import dragged ALL of Three into a 2D-only game bundle (measured: ~289 KB of
 *  three/webgpu in the chess build). The fix moved the shared shape + constants into a
 *  three-FREE `mtsdfStyle.ts`.
 *
 *  This test walks the relative-import closure from the 2D text entry (`tests/helpers/
 *  importClosure.ts`) and fails if any module in it imports `three/webgpu` or `three/tsl` — so
 *  a future edit that re-couples the 2D text path to the Three shader is caught here, not in a
 *  bloated build. `render3dBoundary.test.ts` is the same guard over the whole 2D boot path. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkClosure, importsOf } from '../helpers/importClosure';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const ENTRY = 'runtime/rendering/text/mtsdfPixiShader.ts';

const FORBIDDEN = ['three/webgpu', 'three/tsl'];

describe('2D MTSDF text path is Three-node-pipeline free (Phase 2c boundary)', () => {
  it(`static import closure from mtsdfPixiShader never reaches ${FORBIDDEN.join(' / ')}`, () => {
    const { offenders, visited } = walkClosure({ srcDir, entries: [ENTRY], forbidden: FORBIDDEN });
    // Non-vacuity: a walker that resolved nothing would report zero offenders and look green.
    expect(visited.length).toBeGreaterThan(1);
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
