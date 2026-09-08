/** `main.ts` must export MODOKI_PACKAGED=1 into its own process env when packaged (#0.5.1).
 *
 *  This is the PRODUCER half of the packaged-editor build guard; `vendorEnginePlugins`'s
 *  "the packaged-editor default (MODOKI_PACKAGED)" describe block is the consumer half.
 *  Both are needed, and the reason is the defect this pair was written for: a guard existed
 *  in `ensurePluginBuilt` for exactly this case, `main.ts` passed `canBuild` to it correctly,
 *  and it STILL shipped broken — because the two call sites that actually run during a native
 *  build (`vite-asset-scanner`'s build path and `addNativeTarget`'s auto-scaffold) live in the
 *  Vite dev-server process and passed nothing. A consumer-only test would pass just as happily
 *  with nobody setting the variable, which is the same shape of hole one level up.
 *
 *  A SOURCE guard because the alternative is booting Electron in jsdom, which asserts the mock.
 *  What it can prove is narrow but exactly the load-bearing bit: the assignment exists, it is
 *  conditioned on `app.isPackaged`, and it happens on `process.env` (so children inherit it —
 *  `devServer.ts` spawns Vite with `...process.env`, and build-web.mjs runs under that). */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const MAIN = path.join(__dirname, '../../electron/main.ts');
const src = readScannedSource(MAIN).code;

describe('main.ts publishes the packaged signal to child processes', () => {
  it('sets process.env.MODOKI_PACKAGED, gated on app.isPackaged', () => {
    // Tolerant of formatting, strict about the three load-bearing parts.
    expect(src, 'main.ts must set MODOKI_PACKAGED so the Vite dev server (and anything it spawns) '
      + 'can tell it is inside a packaged editor — see vendorPlugins.ts\'s canBuild default')
      .toMatch(/if\s*\(\s*app\.isPackaged\s*\)\s*process\.env\.MODOKI_PACKAGED\s*=\s*'1'/);
  });

  it('assigns it to process.env, not a local — children inherit it or the fix does nothing', () => {
    const line = src.split('\n').find((l) => l.includes('MODOKI_PACKAGED'));
    expect(line).toBeDefined();
    expect(line!).toContain('process.env.MODOKI_PACKAGED');
  });

  it('devServer spawns the Vite child with the inherited env (the delivery path)', () => {
    // If this ever stops spreading process.env, the signal above silently stops arriving and
    // the packaged editor goes back to killing its own dev server on the first native build.
    const dev = readScannedSource(path.join(__dirname, '../../electron/devServer.ts')).code;
    expect(dev, 'devServer.ts must spawn Vite with `...process.env` for MODOKI_PACKAGED to reach it')
      .toMatch(/env:\s*\{\s*\.\.\.process\.env/);
  });
});
