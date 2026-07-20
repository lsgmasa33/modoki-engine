/**
 * Guards the scaffold template's scene format version (P3-6). The scaffolder
 * (engine/electron/newProject.ts + scripts/scaffold-project.mjs) copies the
 * starter template's scene verbatim, so the stamped version is the template
 * scene's `version` field. This test fails if that drifts from the engine's
 * SCENE_FORMAT_VERSION source of truth — so a future format bump can't silently
 * leave the template (and every new project) stamping a stale, unmigrated version.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('SCENE_FORMAT_VERSION sync', () => {
  it('starter template scene matches the engine source of truth', () => {
    const src = readFileSync(path.join(root, 'packages/modoki/src/runtime/version.ts'), 'utf8');
    const m = src.match(/SCENE_FORMAT_VERSION\s*=\s*(\d+)/);
    if (!m) throw new Error('SCENE_FORMAT_VERSION not found in version.ts');
    const engine = Number(m[1]);

    const scene = JSON.parse(readFileSync(path.join(root, 'templates/starter/runtime/assets/scenes/main.json'), 'utf8'));
    expect(scene.version).toBe(engine);
  });
});
