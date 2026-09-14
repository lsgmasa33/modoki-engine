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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readScannedSource } from '@modoki/engine/testing';
import { findNodes, flatText, lineOf, parseSource, ts } from '@modoki/engine/testing/sourceAst';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '../../scripts');
const copyThreeAddons = require_(path.join(scriptsDir, 'copy-three-addons.cjs')).default;

const tmpdirs: string[] = [];
function tmp(): string {
  const d = makeScratchDir('modoki-pack-', { canonical: true });
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
    // `controls/`, which is where real three keeps it — the fixture previously put it under
    // `loaders/` (via a `'controls','..','loaders'` join that normalized away), which made the
    // tree a shape three never produces and quietly turned this file into loader-count padding.
    fs.mkdirSync(path.join(jsm, 'controls'), { recursive: true });
    fs.writeFileSync(path.join(jsm, 'controls', 'OrbitControls.js'), '// orbit');
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
    // A subdirectory OTHER than loaders/, so the copy is proved recursive rather than
    // loaders-shaped — OrbitControls is what the editor's own viewport needs.
    expect(fs.existsSync(path.join(dest, 'controls', 'OrbitControls.js')), 'OrbitControls must reach the packed app').toBe(true);
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

/** Every string or template part in `code` saying `failed to run`, each with whether IT is thrown: the
 *  expression it is part of — up to its own statement — is the operand of a `throw`.
 *
 *  ⚠️ **The message's own statement, not its line (#1179).** The line test asked whether `throw new
 *  Error` sat on the same line as the text: `throw new Error(\n  \`… failed to run: …\`,\n)` — a
 *  formatter's wrap — read as a warn, and `console.warn('… failed to run'); throw new Error(e)` on one
 *  line read as a throw. */
function failedToRunMessages(code: string, label: string): Array<{ site: string; thrown: boolean }> {
  return findNodes(parseSource(code, label), (n): n is ts.StringLiteralLike | ts.TemplateLiteralLikeNode =>
    (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes('failed to run'))
    .map((t) => {
      let cur: ts.Node = t;
      while (cur.parent && !ts.isStatement(cur.parent) && !ts.isFunctionLike(cur.parent)) cur = cur.parent;
      return { site: `${label}:${lineOf(t)}: ${flatText(cur)}`, thrown: !!cur.parent && ts.isThrowStatement(cur.parent) };
    });
}

describe('the failed-to-run reader asks each message whether IT is thrown (#1179)', () => {
  const thrown = (src: string) => failedToRunMessages(src, 'fixture.cjs').map((m) => m.thrown);

  it('reads a wrapped throw and every copy', () => {
    expect(thrown("throw new Error(\n  `[stage] staged x but it failed to run: ${e.message}`,\n  { cause: e },\n);\nconsole.warn('[stage] y failed to run');"))
      .toEqual([true, false]);
  });

  it('a throw beside a warned message on the same line does not vouch for it', () => {
    expect(thrown("console.warn('[stage] x failed to run'); throw new Error(String(e));")).toEqual([false]);
  });

  it('a message inside a callback that is thrown is not what is thrown', () => {
    expect(thrown("throw once(() => { console.warn('[stage] x failed to run'); });")).toEqual([false]);
  });

  it('a message built into an Error that is not thrown is not thrown', () => {
    expect(thrown("const err = new Error('[stage] x failed to run'); console.warn(err.message);")).toEqual([false]);
  });
});

describe('the staging hooks do not discard their own verification (#945 B3)', () => {
  const stagers = ['stage-toktx.cjs', 'stage-msdf.cjs'].map((f) => path.join(scriptsDir, f));

  it('a staged binary that fails to run aborts the pack rather than warning', () => {
    // Both stagers verify their staged copy by running it — `toktx --version`, and
    // `msdf-atlas-gen` with no args, which exits non-zero when dyld cannot resolve the sibling
    // dylibs the stager just relocated. That verdict used to be `console.warn`ed and dropped.
    //
    // ⚠️ This is a SOURCE scan and it knows it: it can see that "failed to run" is reported by a
    // throw rather than a warn, and it CANNOT see whether the staged binary actually works.
    // Running the staged binary from inside a packed app is verify:packaged's job and is still
    // open. Scoped to "failed to run" deliberately — the OTHER warnings in these files are the
    // legitimate graceful skips for a tool that is absent on this build machine, which
    // before-pack.cjs documents and which must stay warnings.
    const offenders = stagers.flatMap((f) => failedToRunMessages(readScannedSource(f).code, path.basename(f)))
      .filter((m) => !m.thrown).map((m) => m.site);
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
      expect(failedToRunMessages(readScannedSource(f).code, path.basename(f)).length, `${path.basename(f)} lost its staged-binary sanity check`)
        .toBeGreaterThan(0);
    }
  });
});
