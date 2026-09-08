// @vitest-environment node
/**
 * #945 B3/B4 — the packaging hooks are driven, and their own verdicts are not discarded.
 *
 * The class: a file is copied/staged into the place it actually runs, and what verifies it reads
 * the SOURCE or rebuilds its own copy. B3/B4 were the extreme end — nothing verified them at all.
 *
 * ⚠️ **Sharpening the issue's diagnosis: it is worse than "no test".** Both toolchain stagers
 * ALREADY sanity-run the staged binary (`toktx --version`, `msdf-atlas-gen` with no args, which
 * only exits 0 if its sibling dylibs resolve) — and then `console.warn`ed the failure and carried
 * on. The check existed; its verdict was thrown away. So a binary that could not run was staged,
 * signed and shipped, and the only signal was a line in a packaging log. Same for
 * `copy-three-addons`, whose missing-SOURCE path warned and returned — shipping an app in which
 * no GLB or HDR loads and no scene renders.
 *
 * ⚠️ **What this suite does and does NOT cover — read before trusting it.**
 *  - `copy-three-addons` is fully context-driven (`appOutDir` / `packager.projectDir`), so the
 *    REAL hook runs here against a real staged tree in a tmpdir. That half is genuinely covered.
 *  - The two toolchain stagers write to a FIXED repo path (`build/bin`, module-level `BIN_DIR`),
 *    so driving them in a unit test would write into this checkout. They are covered here only
 *    by rule 2 below — an architecture guard that their verdict is not discarded. **Running the
 *    STAGED binary from inside a packed app remains uncovered** and belongs to `verify:packaged`,
 *    which is the fixture design #945 says this half needs. Stated so the suite is not mistaken
 *    for closing B3.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '../../scripts');
const copyThreeAddons = require_(path.join(scriptsDir, 'copy-three-addons.cjs')).default;

const tmpdirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'modoki-pack-'));
  tmpdirs.push(d);
  return d;
}
afterAll(() => { for (const d of tmpdirs) fs.rmSync(d, { recursive: true, force: true }); });

const PRODUCT = 'Modoki Editor';

/** A minimal stand-in for what electron-builder hands an afterPack hook, plus a project dir
 *  whose node_modules/three may or may not exist. */
function makeContext(opts: { withThree: boolean; platform?: string }) {
  const root = tmp();
  const projectDir = path.join(root, 'project');
  const appOutDir = path.join(root, 'out');
  const platform = opts.platform ?? 'darwin';
  const resources = platform === 'darwin'
    ? path.join(appOutDir, `${PRODUCT}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  if (opts.withThree) {
    const jsm = path.join(projectDir, 'node_modules', 'three', 'examples', 'jsm');
    fs.mkdirSync(path.join(jsm, 'loaders'), { recursive: true });
    fs.writeFileSync(path.join(jsm, 'loaders', 'GLTFLoader.js'), '// glb');
    fs.writeFileSync(path.join(jsm, 'loaders', 'HDRLoader.js'), '// hdr');
    fs.writeFileSync(path.join(jsm, 'loaders', 'OrbitControls.js'), '// orbit');
  } else {
    fs.mkdirSync(projectDir, { recursive: true });
  }
  return {
    ctx: { appOutDir, electronPlatformName: platform, packager: { projectDir, appInfo: { productFilename: PRODUCT } } },
    resources,
  };
}

describe('copy-three-addons afterPack hook (#945 B4)', () => {
  it('copies three/examples/jsm into the packed app.asar.unpacked', async () => {
    const { ctx, resources } = makeContext({ withThree: true });
    await copyThreeAddons(ctx);
    const dest = path.join(resources, 'app.asar.unpacked', 'node_modules', 'three', 'examples', 'jsm');
    expect(fs.existsSync(path.join(dest, 'loaders', 'GLTFLoader.js')), 'GLTFLoader must reach the packed app').toBe(true);
    expect(fs.existsSync(path.join(dest, 'loaders', 'HDRLoader.js')), 'HDRLoader must reach the packed app').toBe(true);
  });

  it('resolves the Resources dir per platform, not just on macOS', async () => {
    const { ctx, resources } = makeContext({ withThree: true, platform: 'win32' });
    await copyThreeAddons(ctx);
    expect(fs.existsSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js'))).toBe(true);
  });

  it('THROWS when the source is missing instead of shipping an app that renders nothing', async () => {
    // The regression this is really about: the old code warned and returned, so a pack with no
    // three/examples/jsm produced an app that starts, opens a window, and draws an empty
    // viewport — with nothing downstream able to catch it.
    const { ctx } = makeContext({ withThree: false });
    await expect(copyThreeAddons(ctx)).rejects.toThrow(/refusing to pack/);
  });
});

describe('the staging hooks do not discard their own verification (#945 B3)', () => {
  const stagers = ['stage-toktx.cjs', 'stage-msdf.cjs'].map((f) => path.join(scriptsDir, f));

  it('the comment scan is sane over both stagers', () => {
    for (const f of stagers) {
      const raw = fs.readFileSync(f, 'utf8');
      assertScanIsSane(raw, stripComments(raw), path.basename(f));
    }
  });

  it('a staged binary that fails to run aborts the pack rather than warning', () => {
    // Both stagers verify their staged copy by running it — `toktx --version`, and
    // `msdf-atlas-gen` with no args, which exits non-zero when dyld cannot resolve the sibling
    // dylibs the stager just relocated. That verdict used to be `console.warn`ed and dropped.
    //
    // ⚠️ This is a TEXT scan and it knows it: it can see that "failed to run" is reported by a
    // throw rather than a warn, and it CANNOT see whether the staged binary actually works.
    // Running the staged binary from inside a packed app is verify:packaged's job and is still
    // open. Scoped to "failed to run" deliberately — the OTHER warnings in these files are the
    // legitimate graceful skips for a tool that is absent on this build machine, which
    // before-pack.cjs documents and which must stay warnings.
    const offenders: string[] = [];
    for (const f of stagers) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const line of src.split('\n')) {
        if (!/failed to run/.test(line)) continue;
        if (!/throw new Error/.test(line)) offenders.push(`${path.basename(f)}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      'a stager that verifies its staged binary and then only warns will sign and ship a binary '
        + 'that cannot run (#945 B3) — throw, so the pack stops. A tool that is ABSENT is a '
        + 'different case and stays a graceful skip.',
    ).toEqual([]);
  });

  it('…and each stager really does carry such a check, so the rule above is not vacuous', () => {
    // Without this, deleting the sanity-run entirely would satisfy the rule above by having
    // nothing to match — the guard would go green on the very regression it exists to stop.
    for (const f of stagers) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      expect(src, `${path.basename(f)} lost its staged-binary sanity check`).toMatch(/failed to run/);
    }
  });
});
