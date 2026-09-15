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
 *  the define. Test files are excluded (a test naming a define is not a branch), and so is every
 *  occurrence that DEFINES it (see `readsDefine`) — otherwise every key trivially passes on the
 *  strength of its own definition, which is precisely the vacuous check that let #256 through. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MODULE_KEYS } from '../../plugins/detect-modules';
import { REPO_ROOT } from '../helpers/repoLayout';
import { stripComments, stripCommentsAndStrings, assertScanIsSane, readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { parseSource, propertyValue, stringValueOf, ts, unwrapValue, variablesNamed } from '@modoki/engine/testing/sourceAst';

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

/** Does comment-stripped `code` READ `token`, rather than only DEFINE it?
 *
 *  ⚠️ **Derived from the definition's SHAPE, not a hand list of definition files (#1140).** This was
 *  `DEFINITION_SITES`, three files filtered out of the corpus — and a FOURTH definition site,
 *  `engine/electron/ssrLoader.ts` (the SSR loader's own `define: { __MODOKI_MODULE_*__: 'true' }`
 *  block), was never on it. So every key counted ssrLoader.ts as a consumer, and "at least one
 *  source file branches on its define" could not fail for ANY key: delete every real branch and the
 *  SSR loader's definition still vouched. That is #256 again, one file over. A definition is the
 *  token in object-KEY position (`{`/`,`/line start, then `token:`); any other occurrence is a
 *  read. `.d.ts` declarations are already outside the corpus.
 *
 *  ⚠️ **`code` must be stripped of STRINGS as well as comments** (#1140 close-out review). With
 *  comments alone, three string literals that merely MENTION `__MODOKI_MODULE_VIDEO__` (a `reason`
 *  in `agentBridge.ts`, a contract `notes` in `contracts.ts`, a `.describe(...)` in the MCP runtime
 *  tools) counted as consumers — so deleting every real video branch still left the per-key check
 *  green, #256 once more. Quoted-key definitions vanish with the strings, which is harmless.
 *
 *  The key position is matched on ONE line (`[ \t]*`, not `\s*`), so a multi-line ternary
 *  (`cond ?\n  TOKEN\n  : b`) stays a read, and a computed key (`[TOKEN]:`) counts as a definition.
 *  Known gap, stated rather than guessed at: `declare const TOKEN: boolean;` in a plain `.ts`
 *  file reads as a read (no such declaration exists outside `.d.ts` today). */
function readsDefine(code: string, token: string): boolean {
  const all = code.split(token).length - 1;
  const asKey = [...code.matchAll(new RegExp(`(?:^|[{,[])[ \\t]*${token}\\]?[ \\t]*:(?!:)`, 'gm'))].length;
  return all > asKey;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'tests', 'e2e']);

/** Every `.ts`/`.tsx` (non-declaration) source under `engine/`, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). Floored well under the 1011 measured today. */
const sources = (() => {
  return repoFiles({
    under: path.join(REPO_ROOT, 'engine'),
    match: (rel: string) => {
      if (!/\.tsx?$/.test(rel) || rel.endsWith('.d.ts')) return false;
      return !rel.split('/').some((s) => s.startsWith('.') || SKIP_DIRS.has(s));
    },
    floor: 700,
  })
    .map(({ rel }) => rel);
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
    const consumers = sources.filter((rel) => readsDefine(
      stripCommentsAndStrings(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), rel), token));
    expect(
      consumers,
      `build.modules.${key} is offered as a toggle but NOTHING reads ${token}, so turning it off ` +
      `removes no code and reports nothing (#256). Either gate the module's seam on ${token} — the ` +
      `check must return BEFORE the import, in the same function, or it folds nothing — or delete ` +
      `the toggle from MODULE_KEYS, BuildModules, the defines and ModuleTogglesEditor.`,
    ).not.toHaveLength(0);
  });

  it('a definition is not a read — the classifier tells them apart, and every real definition site is recognised', () => {
    const t = '__MODOKI_MODULE_VIDEO__';
    expect(readsDefine(`export default { define: {\n  ${t}: 'true',\n} };`, t)).toBe(false);
    expect(readsDefine(`const d = { a: 1, ${t}: JSON.stringify(x) };`, t)).toBe(false);
    expect(readsDefine(`const d = { [${t}]: 1 };`, t)).toBe(false);
    expect(readsDefine(`if (${t}) { await import('./video'); }`, t)).toBe(true);
    expect(readsDefine(`const on = ${t} ? load() : null;`, t)).toBe(true);
    expect(readsDefine(`const on = cond ?\n  ${t}\n  : fallback;`, t)).toBe(true);
    // A string that merely MENTIONS the define is not a read — once strings are stripped.
    const mention = `const reason = 'gated on ${t}';`;
    expect(readsDefine(stripCommentsAndStrings(mention, 'x.ts'), t)).toBe(false);
    // The premise: every file that DEFINES the defines — the four known ones, ssrLoader.ts among
    // them — reads none of them, so none can vouch for a key.
    for (const rel of ['engine/vite.config.ts', 'engine/plugins/vite-asset-scanner.ts',
      'engine/packages/modoki/vitest.config.ts', 'engine/electron/ssrLoader.ts']) {
      const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(stripComments(raw).includes(defineName('video')), `${rel} no longer defines the video toggle`).toBe(true);
      const code = stripCommentsAndStrings(raw, rel);
      expect(MODULE_KEYS.filter((key) => readsDefine(code, defineName(key))), rel).toEqual([]);
    }
  });

  it('the Engine Modules panel offers exactly the keys MODULE_KEYS resolves', () => {
    const panelPath = 'engine/packages/modoki/src/editor/panels/ModuleTogglesEditor.tsx';
    // The array and each row's `key` are NODES (#1195). This was `indexOf('const MODULES')` up to the
    // first `'\n];'` with `key:\s*'…'` matched inside — a longer `const MODULES_…` name, a closer at that
    // indent inside a row, or a double-quoted key each changed the rows it read.
    const abs = path.join(REPO_ROOT, panelPath);
    const decls = variablesNamed(parseSource(readScannedSource(abs).code, abs), 'MODULES');
    expect(decls.length, `${panelPath} no longer declares one MODULES array — this guard needs updating`).toBe(1);
    const init = decls[0]!.initializer && unwrapValue(decls[0]!.initializer);
    expect(init && ts.isArrayLiteralExpression(init), `${panelPath}'s MODULES is no longer an array literal`).toBe(true);
    const rows = (init as ts.ArrayLiteralExpression).elements.map((el) => stringValueOf(propertyValue(el, 'key') as ts.Expression));
    expect(rows.filter((k) => k === undefined).length, `a ${panelPath} row has no string \`key\` — it can resolve to no module`).toBe(0);

    expect(
      [...rows].sort(),
      `${panelPath}'s rows and MODULE_KEYS disagree. A key with no row is a working toggle the ` +
      `owner can only reach by hand-editing project.config.json (that was 'video' until #256); a ` +
      `row with no key is a switch that resolves to nothing.`,
    ).toEqual([...MODULE_KEYS].sort());
  });
});
