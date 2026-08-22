/** The two Stage-A SSR loaders must declare the SAME `__MODOKI_MODULE_*__` defines.
 *
 *  WHY THIS GUARD EXISTS. A model postprocessor is loaded through an SSR Vite server so its
 *  THREE.Mesh fixups can run at bake time. There are TWO such servers, in different files:
 *
 *    - engine/electron/ssrLoader.ts            — the dev + packaged EDITOR (re-import)
 *    - engine/plugins/vite-asset-scanner.ts    — the BUILD-time bake
 *
 *  Both pass `configFile: false`, so neither inherits `engine/vite.config.ts`'s `define`
 *  block. The engine runtime modules a postprocessor pulls in (via `@modoki/engine/runtime`)
 *  reference the `__MODOKI_MODULE_*__` flag globals for DCE, so without a local `define` the
 *  module evaluation throws `ReferenceError: __MODOKI_MODULE_RENDER2D__ is not defined`,
 *  `resolvePostprocessorForId` returns null, and Stage A **silently bakes a passthrough**.
 *
 *  That is not a visible failure. There is no error in the editor — the postprocessor's
 *  generated UVs simply never happen, the texture samples an absent `uv`, and the mesh renders
 *  flat. It was fixed in the build-time loader and NOT the editor one, so every editor
 *  re-import passed through un-fixed while the shipped build was correct. Measured on
 *  games/3d-test: 15 of 24 primitives had UVs before the fix, 24 of 24 after; zero material
 *  fixups landed before, four after.
 *
 *  A unit test cannot catch this (it is a Vite server config, exercised only by a real bake),
 *  and the runtime symptom is silent — so the drift itself is what gets guarded. Source-text
 *  assertions on purpose: importing either module would stand up a Vite server. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every flag `engine/vite.config.ts` defines for the client build. The SSR loaders must
 *  cover all of them — derived from the config rather than hardcoded, so a NEW module flag
 *  is caught here the day it is added instead of the next time someone re-imports a model. */
function flagsFromViteConfig(): string[] {
  const src = fs.readFileSync(path.join(ENGINE_ROOT, 'vite.config.ts'), 'utf8');
  const found = [...src.matchAll(/__MODOKI_MODULE_[A-Z0-9]+__/g)].map((m) => m[0]);
  return [...new Set(found)];
}

const LOADERS = [
  { label: 'editor re-import (electron/ssrLoader.ts)', file: 'electron/ssrLoader.ts' },
  { label: 'build-time bake (plugins/vite-asset-scanner.ts)', file: 'plugins/vite-asset-scanner.ts' },
];

describe('Stage-A SSR loaders define the module flags', () => {
  const flags = flagsFromViteConfig();

  it('vite.config.ts declares at least one module flag (the guard has something to compare)', () => {
    // Without this the two assertions below would pass vacuously if the naming ever changed.
    expect(flags.length).toBeGreaterThan(0);
  });

  for (const { label, file } of LOADERS) {
    it(`${label} defines every __MODOKI_MODULE_*__ flag`, () => {
      const src = fs.readFileSync(path.join(ENGINE_ROOT, file), 'utf8');
      const missing = flags.filter((f) => !src.includes(f));
      expect(missing, `${file} is missing ${missing.join(', ')} — a postprocessor loaded through `
        + 'it will throw ReferenceError and Stage A will silently bake a PASSTHROUGH '
        + '(symptom: untextured geometry, no error anywhere)').toEqual([]);
    });
  }

  it('both loaders pass configFile:false, which is WHY they need their own define', () => {
    // If a loader ever stops using configFile:false it inherits vite.config.ts's define and
    // this guard's premise changes — fail loudly so the reasoning gets re-read, not silently
    // keep asserting a requirement that no longer applies.
    for (const { file } of LOADERS) {
      const src = fs.readFileSync(path.join(ENGINE_ROOT, file), 'utf8');
      expect(src, `${file}`).toMatch(/configFile:\s*false/);
    }
  });
});
