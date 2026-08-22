// @vitest-environment node
/** The packaged editor's CJS Vite config (#326).
 *
 *  The packaged editor's REPO_ROOT is inside the signed `.app`, and Vite's default config
 *  loader writes its compiled config to `<nearest node_modules>/.vite-temp` — inside the
 *  bundle. Only the loader's ESM branch does that; the CJS branch compiles in memory. So the
 *  packaged app ships an esbuild-bundled `.cjs` copy of `vite.config.ts` and `build-web.mjs`
 *  hands Vite that one.
 *
 *  Bundling to CJS empties `import.meta`, and the config's plugin graph is FULL of modules
 *  that locate themselves through `import.meta.url`. Three of them already branch to
 *  `__filename`/`__dirname` when it is absent (and `native-dynamic-import.ts` DEPENDS on the
 *  absence — do not "fix" it with a `--define`). One that did not, `courtAuthored.mjs`, made
 *  the whole packaged build die at config load with `fileURLToPath(undefined)`. That is the
 *  regression these tests exist for: it is invisible to every other suite, because nothing
 *  else loads this config as CJS. */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// jsdom's TextEncoder breaks esbuild's startup invariant — hence the node environment above.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { chooseViteConfig, isPackagedEngineDir } from '../../scripts/viteConfigChoice.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const engineDir = path.join(repoRoot, 'engine');
const configEntry = path.join(engineDir, 'vite.config.ts');

/** Bundle the config exactly as `stage-vite-config.cjs` does, without writing it. */
async function bundlePackagedConfig() {
  return build({
    entryPoints: [configEntry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    write: false,
    logLevel: 'silent',
    logLimit: 0,
  });
}

describe('packaged Vite config (#326)', () => {
  it('uses import.meta VERBATIM everywhere in the config graph — no paraphrase', async () => {
    const result = await bundlePackagedConfig();
    const empties = result.warnings.filter((w) => w.id === 'empty-import-meta');
    // The rule, and why it is about SHAPE rather than about what the value is used for. Vite's
    // config bundler rewrites the exact expression `import.meta.url` to the defining module's
    // URL. A paraphrase — `(import.meta as { url?: string }).url` — slips past that define and
    // silently resolves to the TEMP FILE under node_modules/.vite-temp instead. Measured against
    // vite 8.2.0 with a `.ts` config under a `"type": "module"` root (the repo's own shape), for
    // the entry config AND for an imported module.
    //
    // So: every `import.meta` in this graph must either be a member access (`import.meta.url`)
    // or a bare `typeof` guard. An earlier version of this test asked instead whether the value
    // was passed straight into a throwing path function — which missed
    // `createRequire((import.meta as {...}).url)`, the exact defect, and flagged safe code.
    // Column-free on purpose: esbuild emits one warning PER occurrence, so a line with both a
    // `typeof` guard and a member access reports twice, and slicing by column got it wrong by one.
    // Strip every legitimate shape from the line; anything still holding `import.meta` is a
    // paraphrase.
    const offenders = empties.filter((w) => {
      const rest = (w.location?.lineText ?? '')
        .replace(/typeof\s+import\.meta\b/g, '')
        .replace(/import\.meta\.[A-Za-z]/g, '');
      return /import\.meta/.test(rest);
    });
    expect(
      offenders.map((w) => `${w.location?.file}:${w.location?.line} — ${w.location?.lineText?.trim()}`),
    ).toEqual([]);
    // Not vacuous: if esbuild stops emitting this warning id the filter matches nothing forever.
    expect(empties.length).toBeGreaterThan(0);
  });

  it('the CJS bundle EVALUATES — the failure mode is a throw at load, not a bad value', async () => {
    const result = await bundlePackagedConfig();
    const code = result.outputFiles![0].text;
    // Must load from inside engine/: the bundle collapses the plugin graph into one file, and its
    // modules locate themselves relative to their own path. `stage-vite-config.cjs` emits it here
    // for exactly that reason, so evaluating it anywhere else would not be the same test.
    const probe = path.join(engineDir, `vite.config.__packagedtest-${process.pid}.cjs`);
    writeFileSync(probe, code);
    try {
      const mod = createRequire(import.meta.url)(probe) as { default?: unknown };
      expect(mod.default).toBeDefined();
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

describe('chooseViteConfig', () => {
  it('a DEV clone always gets the .ts — even with a stray .cjs sitting next to it', () => {
    // The stale-copy trap: a pack that fails between beforePack and afterPack leaves the staged
    // .cjs behind. Under the first cut (choose by existence) every later dev build in that clone
    // silently used that frozen snapshot. Packaged-ness, not existence, is the discriminator.
    const dir = mkdtempSync(path.join(tmpdir(), 'modoki-viteconfig-'));
    try {
      const env = {} as NodeJS.ProcessEnv;
      expect(chooseViteConfig(dir, undefined, env)).toBe('engine/vite.config.ts');
      writeFileSync(path.join(dir, 'vite.config.cjs'), '// stale, left by a failed pack');
      expect(chooseViteConfig(dir, undefined, env)).toBe('engine/vite.config.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a PACKAGED app gets the staged .cjs — by path marker, and by env when asar is off', () => {
    const packagedDir = path.join(path.sep, 'Applications', 'X.app', 'Contents', 'Resources',
      'app.asar.unpacked', 'engine');
    expect(isPackagedEngineDir(packagedDir, {})).toBe(true);
    expect(chooseViteConfig(packagedDir, () => true, {})).toBe('engine/vite.config.cjs');
    // asar disabled → no marker in the path; the env signal still identifies it.
    const plainDir = path.join(path.sep, 'Applications', 'X.app', 'Contents', 'Resources', 'engine');
    expect(isPackagedEngineDir(plainDir, {})).toBe(false);
    expect(chooseViteConfig(plainDir, () => true, { MODOKI_PACKAGED: '1' } as NodeJS.ProcessEnv))
      .toBe('engine/vite.config.cjs');
  });

  it('WARNS rather than silently reverting when packaged and the .cjs was never staged', () => {
    // stage-vite-config.cjs skips gracefully when esbuild is unresolvable. Falling back to the
    // writing config in silence would restore the original bug with nothing said.
    const packagedDir = path.join(path.sep, 'X.app', 'Contents', 'Resources', 'app.asar.unpacked', 'engine');
    const warnings: string[] = [];
    expect(chooseViteConfig(packagedDir, () => false, {}, (m) => warnings.push(m)))
      .toBe('engine/vite.config.ts');
    expect(warnings.join(' ')).toMatch(/code signature|#326/);
  });

  it('the path marker must match a DIRECTORY SEGMENT, not a substring', () => {
    // A project legitimately named e.g. `my-app.asar.unpacked-notes` must not read as packaged.
    expect(isPackagedEngineDir(path.join(path.sep, 'src', 'app.asar.unpacked-notes', 'engine'), {}))
      .toBe(false);
  });

  it('no build script hardcodes the .ts config — every `vite build` goes through the chooser', () => {
    // The sibling that got missed: `build-subgame.mjs` kept `--config engine/vite.config.ts` for
    // two commits after `build-web.mjs` was fixed. Nothing called it from the editor UI, so the
    // bug was latent — which is precisely how it would have shipped when that gets wired up.
    const scripts = readdirSync(path.join(engineDir, 'scripts')).filter((f) => f.endsWith('.mjs'));
    const offenders = scripts.filter((f) =>
      /build\s+--config\s+\S*vite\.config\.ts/.test(
        readFileSync(path.join(engineDir, 'scripts', f), 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
    expect(scripts.length).toBeGreaterThan(5); // not vacuous: the directory must have been read
  });

  it('a DEV clone must not have a staged .cjs — it is gitignored and pack-time only', () => {
    // If this fails, a stray build left one behind and every subsequent dev build would silently
    // use a stale config frozen at whenever it was generated.
    expect(existsSync(path.join(engineDir, 'vite.config.cjs'))).toBe(false);
  });
});
