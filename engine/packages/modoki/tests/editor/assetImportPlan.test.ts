/** planImports — OS-file import naming + conversion-dispatch policy
 *  (editor-panels missing test #6). The Assets panel's `importFiles` computes,
 *  per dropped file, a collision-free destination (" copy" suffix, never
 *  overwrite) and whether the file should be run through the conversion
 *  pipeline (textures/models). Extracted to assetOps.ts (F6) so the policy is
 *  testable without rendering / reading bytes off disk. */

import { describe, it, expect } from 'vitest';
import { planImports, CONVERTIBLE_RE } from '../../src/editor/panels/assetOps';

describe('planImports', () => {
  it('assigns a plain destination when nothing collides', () => {
    const taken = new Set<string>();
    const plan = planImports(['sand.png', 'notes.txt'], '/assets/textures', taken);
    expect(plan.map((p) => p.dest)).toEqual([
      '/assets/textures/sand.png',
      '/assets/textures/notes.txt',
    ]);
  });

  it('suffixes " copy" when the target already exists (never overwrites)', () => {
    const taken = new Set(['/assets/textures/sand.png']);
    const plan = planImports(['sand.png'], '/assets/textures', taken);
    expect(plan[0].dest).toBe('/assets/textures/sand copy.png');
  });

  it('threads `taken` so two same-named files in ONE batch do not collide', () => {
    const taken = new Set<string>();
    const plan = planImports(['rock.glb', 'rock.glb', 'rock.glb'], '/assets/models', taken);
    expect(plan.map((p) => p.dest)).toEqual([
      '/assets/models/rock.glb',
      '/assets/models/rock copy.glb',
      '/assets/models/rock copy 2.glb',
    ]);
    // The taken set was advanced for each planned dest.
    expect(taken.has('/assets/models/rock copy 2.glb')).toBe(true);
  });

  it('flags convertible files (textures/models) for the reimport pipeline, not others', () => {
    const taken = new Set<string>();
    const plan = planImports(
      ['sand.png', 'leaf.jpg', 'art.webp', 'tree.glb', 'scene.gltf', 'readme.md', 'clip.anim.json'],
      '/assets',
      taken,
    );
    const convert = Object.fromEntries(plan.map((p) => [p.name, p.convert]));
    expect(convert['sand.png']).toBe(true);
    expect(convert['leaf.jpg']).toBe(true);
    expect(convert['art.webp']).toBe(true);
    expect(convert['tree.glb']).toBe(true);
    expect(convert['scene.gltf']).toBe(true);
    expect(convert['readme.md']).toBe(false);
    expect(convert['clip.anim.json']).toBe(false);
  });

  it('CONVERTIBLE_RE matches the texture/model source extensions only', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'glb', 'gltf']) {
      expect(CONVERTIBLE_RE.test(`/x/y.${ext}`)).toBe(true);
    }
    for (const ext of ['json', 'fbx', 'obj', 'mp3', 'txt']) {
      expect(CONVERTIBLE_RE.test(`/x/y.${ext}`)).toBe(false);
    }
  });
});
