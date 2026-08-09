/** The reimport registry is populated TWICE — once by the Vite plugin (`configResolved` in
 *  vite-asset-scanner.ts, which serves the dev loop) and once by the Electron main process
 *  (main.ts, which serves the DESKTOP editor). They are two registrations of one registry,
 *  and nothing made them agree.
 *
 *  They drifted: `atlas` and `video` were registered only in the plugin, so `/api/reimport`
 *  in the shipped editor answered "this asset type has no import pipeline" for both, while
 *  the same call over the dev server worked. That is the worst shape for a bug — it looks
 *  fine in exactly the environment you develop in, and only the product is broken.
 *
 *  This asserts the two lists are identical. It reads the SOURCE rather than importing the
 *  modules because main.ts pulls in Electron, which cannot be loaded in a unit test. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ENGINE = path.resolve(__dirname, '../..');

/** Every `registerReimportHandler('<type>', …)` call in a file, in source order. */
function registeredTypes(relPath: string): string[] {
  const src = fs.readFileSync(path.join(ENGINE, relPath), 'utf-8');
  return [...src.matchAll(/registerReimportHandler\(\s*'([a-z0-9-]+)'/gi)].map((m) => m[1]);
}

describe('reimport handler registration parity', () => {
  it('the Vite plugin and Electron main register the SAME asset types', () => {
    const plugin = registeredTypes('plugins/vite-asset-scanner.ts');
    const electron = registeredTypes('electron/main.ts');

    // Sanity: both sites must actually be found, or a refactor that moved/renamed the call
    // would make this test pass by comparing two empty lists.
    expect(plugin.length).toBeGreaterThan(3);
    expect(electron.length).toBeGreaterThan(3);

    expect([...electron].sort()).toEqual([...plugin].sort());
  });

  it('registers video — the type this guard was written for', () => {
    for (const site of ['plugins/vite-asset-scanner.ts', 'electron/main.ts']) {
      expect(registeredTypes(site)).toContain('video');
    }
  });
});
