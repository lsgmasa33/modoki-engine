/** Guard: every engine plugin the ENGINE ITSELF imports is built by root `build:plugins`.
 *
 *  These packages ship their JS only in a **gitignored `dist/`**, and the root `postinstall` chains
 *  `build:plugins` precisely so a fresh clone gets one. A plugin missing from that script is linked
 *  into `node_modules` by the workspace glob (so it LOOKS installed) with no `dist/` behind it —
 *  and the failure lands on whoever clones next, not on the author.
 *
 *  Not hypothetical, and the reason this file exists: `capacitor-modoki-iap` (2026-08-11, the IAP
 *  workstream) was added as a workspace and imported from
 *  `engine/packages/modoki/src/runtime/iap/capacitorStore.ts`, but never added to `build:plugins`.
 *  It typechecked on the authoring clone, where the package had been built by hand, and failed on
 *  the hub the moment it was merged:
 *
 *      error TS2307: Cannot find module 'capacitor-modoki-iap' or its corresponding type declarations
 *
 *  ⚠️ **`npm install` succeeding proves nothing here** — that is exactly what made it confusing.
 *  The install links the workspace and exits 0; only a consumer asking for the package's TYPES
 *  notices the missing `dist/`. Same shape as commit `1a22a9f` (the `capacitor-adjust` case) that
 *  put RULE 1 in CLAUDE.md.
 *
 *  SCOPE: only plugins the engine's own `src/` imports. A plugin used solely by a game reaches it
 *  through a vendored, pre-built `.tgz` (see `games/iap-test/package.json`), so it needs no
 *  workspace build and is deliberately not required here.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const PKG_DIR = 'engine/packages';

/** Workspace plugin packages that publish a build script — the ones a `dist/` is expected of. */
function buildablePlugins(): string[] {
  const dir = path.join(repoRoot, PKG_DIR);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('capacitor-'))
    .filter((e) => {
      const pkg = path.join(dir, e.name, 'package.json');
      if (!fs.existsSync(pkg)) return false;
      return Boolean(JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts?.build);
    })
    .map((e) => e.name);
}

/** Is `name` imported from anywhere under the engine package's own `src/`? */
function importedByEngineSrc(name: string): boolean {
  // `git grep` rather than a walk: it respects .gitignore for free, so a stale build artifact
  // under a gitignored dir cannot vouch for an import that no tracked source actually makes.
  try {
    const out = execFileSync(
      'git',
      ['grep', '-l', '--', `from '${name}'`, '--', `${PKG_DIR}/modoki/src`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim() !== '';
  } catch {
    return false;                       // git grep exits 1 on "no matches" — that is a real answer
  }
}

describe('engine plugins are built by the root postinstall', () => {
  const script: string = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ).scripts['build:plugins'];

  it('finds plugin packages to check — a vacuous pass is a failure', () => {
    // If the layout changes and the glob stops matching, every assertion below passes by checking
    // nothing. The floor is far under the real count (4 as of 2026-08-11), so only a broken
    // enumeration trips it.
    expect(buildablePlugins().length).toBeGreaterThanOrEqual(3);
    expect(script, 'build:plugins must exist').toBeTruthy();
  });

  it('every plugin the ENGINE imports is in build:plugins', () => {
    const missing = buildablePlugins()
      .filter((name) => importedByEngineSrc(name))
      .filter((name) => !script.includes(`${PKG_DIR}/${name}`));

    expect(
      missing,
      'these plugins are imported by engine src but never built by `npm install`, so a fresh '
        + 'clone gets a linked package with no dist/ and fails typecheck with TS2307. Add '
        + '`--workspace engine/packages/<name>` to build:plugins in the root package.json.',
    ).toEqual([]);
  });
});
