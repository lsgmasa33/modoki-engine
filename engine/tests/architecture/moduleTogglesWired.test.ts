/** Guard: every `build.modules` toggle actually REMOVES something, and every one of them is
 *  reachable from the editor's panel.
 *
 *  #256: `build.modules.npr` and `.gpuParticles` were resolved by `resolveModules`, carried
 *  dedicated ride-along logic in `detectModules`, were emitted as `__MODOKI_MODULE_NPR__` /
 *  `__MODOKI_MODULE_GPU_PARTICLES__` Vite defines, and were offered to the owner as Auto | On |
 *  Off rows in Project Settings → Engine Modules — and **no source file ever branched on either
 *  define**. Setting one to `false` shipped the feature unchanged and reported nothing. Both were
 *  deleted rather than wired (the measurement, and why, is in docs/playable-export.md).
 *
 *  Nothing could see that. `npm test` cannot notice an unread constant, and the failure is
 *  maximally quiet: the build succeeds, the define is emitted, the UI shows a switch, and the
 *  bundle is byte-identical. It survived long enough to be documented as a feature. So the
 *  invariant gets a test, the same way #214's ungated-import class got `render3dBoundary.test.ts`.
 *
 *  Two directions, because the surface lied in one and could lie in the other:
 *
 *  1. **A key with no consumer** — a toggle that removes nothing. This is #256 itself.
 *  2. **A key with no row** — a working toggle the owner cannot reach. `video` was exactly this
 *     when #256 was fixed: fully wired, 8 consumers, the only module carrying a media payload
 *     (2.7 MB on demos/video-demo), and absent from the panel, editable only by hand-writing JSON.
 *
 *  What counts as a CONSUMER is deliberately narrow: shipped source under `engine/` that mentions
 *  the define. Test files are excluded (a test naming a define is not a branch), and so are the
 *  four places that DEFINE or DECLARE it — otherwise every key trivially passes on the strength of
 *  its own definition, which is precisely the vacuous check that let #256 through. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MODULE_KEYS } from '../../plugins/detect-modules';
import { REPO_ROOT } from '../helpers/repoLayout';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

/** `gpuParticles` → `__MODOKI_MODULE_GPU_PARTICLES__`; `render3d` → `__MODOKI_MODULE_RENDER3D__`
 *  (no camel boundary before a digit, so it does NOT become `RENDER_3D`). */
function defineName(key: string): string {
  return `__MODOKI_MODULE_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}__`;
}

/** Comment stripping is the shared scanner (`@modoki/engine/testing`, #419).
 *
 *  Why this guard strips at all — its own #256, caught in close-out review: the check was a bare
 *  `includes`, and `app/sharedRegistry.ts` names `__MODOKI_MODULE_RENDER3D__` in a doc comment
 *  explaining the DCE. That comment counted as a consumer. Both render keys have real branches
 *  too, so nothing was wrong — but the guard would have stayed GREEN if the last real branch were
 *  deleted and the comment left behind, which is exactly the failure it exists to catch.
 *
 *  ⚠️ **What this still does NOT prove: that the surviving mention is a REACHABLE branch.** An
 *  unused `const x = __MODOKI_MODULE_FOO__` and a file nobody imports both still count — catching
 *  those needs the import graph and an AST, which `render3dBoundary.test.ts` has and this does
 *  not. The gap is narrow and stated rather than papered over. */

/** The files that DEFINE or DECLARE the defines. A mention here is not a consumer. */
const DEFINITION_SITES = new Set([
  'engine/vite.config.ts',
  'engine/plugins/vite-asset-scanner.ts',
  'engine/packages/modoki/vitest.config.ts',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'tests', 'e2e']);

function collectSources(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectSources(full, out);
    else if ((full.endsWith('.ts') || full.endsWith('.tsx')) && !full.endsWith('.d.ts')) out.push(full);
  }
}

const sources = (() => {
  const out: string[] = [];
  collectSources(path.join(REPO_ROOT, 'engine'), out);
  return out
    .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'))
    .filter((rel) => !DEFINITION_SITES.has(rel));
})();

describe('build.modules toggles are wired in both directions', () => {
  it('finds the engine sources to scan (non-vacuity)', () => {
    // A collector that silently returned [] would make every consumer check below pass.
    expect(sources.length).toBeGreaterThan(500);
    expect(MODULE_KEYS.length).toBeGreaterThan(0);
  });

  // The scanner's own self-test (four inline snippets) now lives in sourceScanner.test.ts (#419).

  it('the comment scan is sane over every collected source file', () => {
    for (const rel of sources) {
      const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assertScanIsSane(raw, stripComments(raw), rel);
    }
  });

  it.each(MODULE_KEYS)('%s actually has a define emitted for it', (key) => {
    // Separated from the consumer check on purpose: if `defineName` and the real define name
    // ever disagree (a future key like `render3D` → `RENDER3_D`), the consumer check would
    // report a perfectly-wired toggle as dead. This says which of the two went wrong.
    const viteConfig = fs.readFileSync(path.join(REPO_ROOT, 'engine/vite.config.ts'), 'utf8');
    expect(
      stripComments(viteConfig),
      `No ${defineName(key)} is emitted in engine/vite.config.ts for build.modules.${key}. Either ` +
      `the key was added without its Vite define, or its define is spelled differently than ` +
      `defineName() derives — fix whichever, but do not read this as "the toggle is dead".`,
    ).toContain(defineName(key));
  });

  it.each(MODULE_KEYS)('%s has at least one source file that branches on its define', (key) => {
    const token = defineName(key);
    const consumers = sources.filter((rel) =>
      stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')).includes(token));
    expect(
      consumers,
      `build.modules.${key} is offered as a toggle but NOTHING reads ${token}, so turning it off ` +
      `removes no code and reports nothing (#256). Either gate the module's seam on ${token} — the ` +
      `check must return BEFORE the import, in the same function, or it folds nothing — or delete ` +
      `the toggle from MODULE_KEYS, BuildModules, the defines and ModuleTogglesEditor.`,
    ).not.toHaveLength(0);
  });

  it('the Engine Modules panel offers exactly the keys MODULE_KEYS resolves', () => {
    const panelPath = 'engine/packages/modoki/src/editor/panels/ModuleTogglesEditor.tsx';
    const src = fs.readFileSync(path.join(REPO_ROOT, panelPath), 'utf8');
    const start = src.indexOf('const MODULES');
    expect(start, `${panelPath} no longer declares a MODULES array — this guard needs updating`).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('\n];', start));
    const rows = [...block.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);

    expect(
      [...rows].sort(),
      `${panelPath}'s rows and MODULE_KEYS disagree. A key with no row is a working toggle the ` +
      `owner can only reach by hand-editing project.config.json (that was 'video' until #256); a ` +
      `row with no key is a switch that resolves to nothing.`,
    ).toEqual([...MODULE_KEYS].sort());
  });
});
