/** #1441 — where the Save dialog opens when its caller names no folder.
 *
 *  Found live on Windows: Assets ▸ Create ▸ Particle (and every other toolbar create without a
 *  `defaultFolder`) opened the native panel in `engine/packages/modoki/src/runtime/assets/`, and
 *  accepting the default name wrote `New Particle.particle.json` into the engine's source. The
 *  route's fallback was `firstRootDir()` = `assetRoots[0]`, and `findAssetRoots` pushes the engine's
 *  built-in root FIRST. macOS hid it until #1440 (osascript reopened at its remembered location). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { readScannedSource } from '@modoki/engine/testing';
import { fileURLToPath } from 'node:url';
import { defaultSaveRootDir, findAssetRoots, ENGINE_ASSETS_URL_PREFIX, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { createAssetBackend } from '../../electron/assetBackend';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const engine: AssetRoot = { urlPrefix: ENGINE_ASSETS_URL_PREFIX, absDir: '/repo/engine/assets' };
const project: AssetRoot = { urlPrefix: '/assets', absDir: '/repo/games/x/runtime/assets' };

describe('defaultSaveRootDir', () => {
  it('skips the engine root even though findAssetRoots lists it first', () => {
    expect(defaultSaveRootDir([engine, project])).toBe(project.absDir);
  });

  it('answers null rather than the engine root when the project has no asset root', () => {
    // Falling back to the engine root would be the defect again, on the project that has least
    // reason to write there. Null makes the route say so and the renderer use its in-app prompt.
    expect(defaultSaveRootDir([engine])).toBeNull();
    expect(defaultSaveRootDir([])).toBeNull();
  });
});

describe('the Electron asset backend opens the save dialog in the PROJECT', () => {
  it('firstRootDir() is the project root, with the real engine root present and first', () => {
    const tmp = makeScratchDir('modoki-default-save-root-');
    const projectAssets = path.join(tmp, 'runtime', 'assets');
    fs.mkdirSync(projectAssets, { recursive: true });

    // The premise, asserted rather than assumed: without the engine root in first place this
    // test could not tell the fix from `roots[0]`.
    const roots = findAssetRoots(tmp);
    expect(roots[0]?.urlPrefix).toBe(ENGINE_ASSETS_URL_PREFIX);

    const backend = createAssetBackend({ projectRoot: tmp });
    expect(backend.firstRootDir()).toBe(projectAssets);
  });

  it('the Vite-plugin host answers through the same helper', () => {
    // The browser dev tab's backend is built inside the Vite plugin's server hook, which a unit
    // test cannot construct — so this pins its wiring to the helper the test above exercises.
    const { code } = readScannedSource(path.join(REPO, 'engine/plugins/vite-asset-scanner.ts'));
    expect(code).toMatch(/firstRootDir:\s*\(\)\s*=>\s*defaultSaveRootDir\(assetRoots\)/);
    expect(code).not.toMatch(/firstRootDir:\s*\(\)\s*=>\s*assetRoots\[0\]/);
  });
});
