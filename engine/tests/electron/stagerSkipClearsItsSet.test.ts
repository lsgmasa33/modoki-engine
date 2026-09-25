/** A beforePack stager that SKIPS (no pinned binary) must clear the set an earlier pack staged
 *  (#1571). electron-builder ships all of `build/bin`, so a skip that leaves last run's copy behind
 *  ships a binary this pack could not provision — and a warning in the log that says the opposite.
 *  stage-toktx always did this (`clearStaged`); stage-msdf's macOS skip did not.
 *
 *  Each stager is COPIED into a temp root beside a `pinnedToolForStaging.cjs` stub that finds
 *  nothing, so its `build/bin` is the temp one: the real staging dir is never touched, and neither
 *  the network nor the machine's toolchain is consulted. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const require_ = createRequire(import.meta.url);
const scriptsDir = path.resolve(__dirname, '../../scripts');

/** A temp repo root holding `engine/scripts/<stager>` + a null pin stub, with `build/bin` seeded. */
function sandbox(stager: string, seeded: string[]): { run: () => Promise<void>; bin: string } {
  const root = makeScratchDir('modoki-stager-skip-');
  const dir = path.join(root, 'engine', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(scriptsDir, stager), path.join(dir, stager));
  fs.writeFileSync(path.join(dir, 'pinnedToolForStaging.cjs'), 'module.exports = { pinnedToolForStaging: () => null };\n');
  const bin = path.join(root, 'build', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const n of seeded) fs.writeFileSync(path.join(bin, n), 'stale');
  const mod = require_(path.join(dir, stager)) as { default: (ctx: { electronPlatformName: string }) => Promise<void> };
  return { run: () => mod.default({ electronPlatformName: 'darwin' }), bin };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a skipped macOS stage clears what an earlier pack staged (#1571)', () => {
  it('stage-toktx: toktx, ktx and libktx go; another stager\'s files stay', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { run, bin } = sandbox('stage-toktx.cjs', ['toktx', 'ktx', 'libktx.4.dylib', 'msdf-atlas-gen']);
    await run();
    expect(fs.readdirSync(bin).sort()).toEqual(['msdf-atlas-gen']);
  });

  it('stage-msdf: msdf-atlas-gen and its old dylib closure go; libktx and toktx stay', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { run, bin } = sandbox('stage-msdf.cjs', ['msdf-atlas-gen', 'libpng16.16.dylib', 'libtinyxml2.11.dylib', 'libktx.4.dylib', 'toktx']);
    await run();
    expect(fs.readdirSync(bin).sort()).toEqual(['libktx.4.dylib', 'toktx']);
  });

  it('stage-msdf: a skip with no build/bin at all is still a clean skip', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { run, bin } = sandbox('stage-msdf.cjs', []);
    fs.rmSync(bin, { recursive: true });
    await expect(run()).resolves.toBeUndefined();
    expect(fs.existsSync(bin)).toBe(false);
  });
});
