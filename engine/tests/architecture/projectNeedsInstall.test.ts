/** Every project that declares dependencies must be INSTALLED by the root postinstall (#215).
 *
 *  `bootstrap-game-deps.mjs` used to select on `pkg.workspaces` alone, which reads as "does this
 *  project own sub-packages to link?" — and silently answered "no install needed" for the 14
 *  projects that own no sub-packages but do declare real dependencies. A fresh clone therefore got
 *  no `node_modules` for any of them, and their native builds failed at package resolution:
 *
 *      xcodebuild: error: Could not resolve package dependencies:
 *        the package at '…/games/court/node_modules/@capacitor/haptics' cannot be accessed
 *
 *  The committed `Package.swift` is right to point at the project's OWN node_modules (the
 *  self-contained-game rule); nothing populated it. It is also what makes `cap sync` rewrite that
 *  file into a portability violation — with the package missing locally, Capacitor resolves it to
 *  the repo root and writes an escaping path.
 *
 *  The SWEEP below is the assertion that matters: it walks the real projects on disk, so a project
 *  added later with dependencies and no `workspaces` key cannot reintroduce this silently. The
 *  unit cases just pin the rule's two independent halves.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectNeedsInstall } from '../../scripts/projectNeedsInstall.mjs';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
// Project presence is asked in exactly ONE place (#98) — never an inline `existsSync('games')`.
import { hasAnyProject } from '../helpers/repoLayout';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('projectNeedsInstall — the rule', () => {
  it('selects a project that owns sub-packages to LINK', () => {
    expect(projectNeedsInstall({ workspaces: ['packages/*'] })).toBe(true);
  });

  it('selects a project that only declares dependencies — the #215 case', () => {
    // games/court's exact shape: 10 deps, no `workspaces`. This returned false, and that single
    // false is the whole bug.
    expect(projectNeedsInstall({ dependencies: { '@capacitor/haptics': '^8.0.2' } })).toBe(true);
    expect(projectNeedsInstall({ devDependencies: { vitest: '^3' } })).toBe(true);
  });

  it('skips a project with neither — nothing to link and nothing to install', () => {
    expect(projectNeedsInstall({})).toBe(false);
    expect(projectNeedsInstall({ dependencies: {}, devDependencies: {} })).toBe(false);
    expect(projectNeedsInstall({ name: 'x', scripts: { build: 'tsc' } })).toBe(false);
  });

  it('tolerates junk rather than throwing inside the root postinstall', () => {
    expect(projectNeedsInstall(null as never)).toBe(false);
    expect(projectNeedsInstall(undefined as never)).toBe(false);
  });
});

describe('the bootstrap scripts never treat a present node_modules as "installed"', () => {
  // A source-level guard, because the failure it prevents is invisible from any unit test: npm
  // would have to actually run. `existsSync(node_modules) → continue` reads as a cheap
  // idempotence win and is #215's exact shape — a folder that EXISTS but is STALE (a dependency
  // added after the last install) makes "already installed" true and wrong. `games/court` shipped
  // that way and its iOS build died at package resolution; `bootstrap-mcp-deps.mjs` carried the
  // same shortcut for engine/tools/*, where it would strand an MCP server on a missing package.
  const SCRIPTS = ['bootstrap-game-deps.mjs', 'bootstrap-mcp-deps.mjs'];

  for (const name of SCRIPTS) {
    it(`${name} re-runs npm install rather than skipping on an existing node_modules`, () => {
      const src = readFileSync(path.join(repoRoot, 'engine', 'scripts', name), 'utf8');
      // Strip comments — this file DISCUSSES the wrong pattern at length, and matching prose
      // instead of code is how a guard like this turns into a false positive.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const offenders = code
        .split('\n')
        .filter((l) => /node_modules/.test(l) && /existsSync/.test(l) && /continue|return/.test(l));
      expect(offenders, `${name} skips on a present-but-possibly-stale node_modules`).toEqual([]);
    });
  }

  it('engine/tools/* has exactly ONE installer, so the rule cannot be fixed in only half the places', () => {
    // Both scripts run back to back in the root postinstall. When both walked engine/tools, the
    // second always found node_modules the first had just created and installed nothing — a
    // duplicate that was dead in the normal flow, and a second place for the rule to drift.
    const owners = SCRIPTS.filter((name) => {
      const src = readFileSync(path.join(repoRoot, 'engine', 'scripts', name), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return /'engine',\s*'tools'/.test(code) || /engine\/tools/.test(code);
    });
    expect(owners).toEqual(['bootstrap-mcp-deps.mjs']);
  });
});

describe('projectNeedsInstall — the real projects on disk', () => {
  /** Every discovered project that ships a package.json, with its parsed manifest. */
  const manifests = discoverProjects(repoRoot)
    .map((proj: { dir: string; root: string; name: string }) => {
      const pkgPath = path.join(proj.dir, 'package.json');
      if (!existsSync(pkgPath)) return null;
      try {
        return { label: `${proj.root}/${proj.name}`, pkg: JSON.parse(readFileSync(pkgPath, 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter((m): m is { label: string; pkg: Record<string, unknown> } => m !== null);

  it('every project that declares dependencies is selected for install', () => {
    const declaresDeps = manifests.filter(
      (m) =>
        Object.keys((m.pkg.dependencies ?? {}) as object).length > 0 ||
        Object.keys((m.pkg.devDependencies ?? {}) as object).length > 0,
    );

    // ⚠️ Non-vacuity guard. `discoverProjects` returns [] where games/ and demos/ are absent (the
    // public OSS snapshot), and this whole sweep would then pass by having nothing to check —
    // which is how a guard rots into decoration. Assert emptiness is REAL emptiness.
    if (manifests.length === 0) {
      expect(hasAnyProject(), 'found no manifests, so there must genuinely be no projects').toBe(false);
      return;
    }
    expect(declaresDeps.length, 'this repo really does have projects with dependencies').toBeGreaterThan(0);

    const skipped = declaresDeps.filter((m) => !projectNeedsInstall(m.pkg)).map((m) => m.label);
    expect(skipped, 'these would get NO node_modules on a fresh clone and fail their native build').toEqual([]);
  });
});
