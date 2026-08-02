/** Guard: every engine test file is actually IN a typecheck program.
 *
 *  Issue #23 — for a long time NO engine test file was typechecked (244 under
 *  `engine/tests/**` + 451 under `engine/packages/modoki/tests/**`), by two different
 *  mechanisms: `engine/tsconfig.app.json` only includes `["app","../games","../demos"]`,
 *  and the package's `tsconfig.json` sets `"exclude": ["tests","dist"]`. vitest transpiles
 *  without typechecking, so a mock could drift from the module it stands in for and the
 *  suite stayed green — a test that has silently stopped testing what it claims.
 *
 *  `engine/tsconfig.test.json` + `engine/packages/modoki/tsconfig.test.json` close that,
 *  but a tsconfig can be wrong in a way that LOOKS clean: while writing the package one I
 *  hit exactly that — `exclude: ["tests"]` is INHERITED through `extends`, and an inherited
 *  exclude beats a local include, so it compiled zero test files and reported a cheerful
 *  clean run. A count of errors can't distinguish "no errors" from "no files".
 *
 *  So this asserts COVERAGE, not cleanliness: resolve each config's file list the way tsc
 *  does (glob resolution only — no typechecking, so it stays fast) and require that every
 *  test file on disk appears in it. Adding a test directory that no config picks up, or
 *  re-introducing an exclude that swallows one, fails here instead of going unnoticed. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../../..');

/** Resolve a tsconfig to the concrete file list tsc would compile — `parseJsonConfigFileContent`
 *  does the include/exclude/extends resolution without building a program. */
function resolveConfigFiles(configPath: string): string[] {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error, `${configPath} failed to parse`).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  expect(parsed.errors.filter((e) => e.category === ts.DiagnosticCategory.Error)).toEqual([]);
  return parsed.fileNames.map((f) => path.resolve(f));
}

/** Every *.test.ts / *.test.tsx / *.spec.ts under `dir`. */
function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        walk(p);
      } else if (/\.(test|spec)\.tsx?$/.test(e.name)) {
        out.push(path.resolve(p));
      }
    }
  };
  walk(dir);
  return out;
}

const CASES = [
  { label: 'engine/tests', config: 'engine/tsconfig.test.json', testDir: 'engine/tests' },
  {
    label: 'engine/packages/modoki/tests',
    config: 'engine/packages/modoki/tsconfig.test.json',
    testDir: 'engine/packages/modoki/tests',
  },
] as const;

describe('test typecheck coverage (issue #23)', () => {
  for (const { label, config, testDir } of CASES) {
    describe(label, () => {
      const covered = resolveConfigFiles(path.join(repoRoot, config));
      const onDisk = testFilesUnder(path.join(repoRoot, testDir));

      it('has test files on disk to check (the walk itself is not silently empty)', () => {
        expect(onDisk.length).toBeGreaterThan(50);
      });

      it('would DETECT an uncovered test file (this guard can actually fail)', () => {
        // Negative control. The failure mode being guarded against is a config that covers
        // nothing while reporting clean, so a guard that silently matches nothing would be
        // the same bug one level up. `tsconfig.app.json` (engine) and `tsconfig.check.json`
        // (package) are the configs that legitimately exclude tests — resolving one of them
        // must therefore report these very files as uncovered. If this ever passes vacuously,
        // the assertion below is meaningless too.
        const excludesTests = label.startsWith('engine/packages')
          ? 'engine/packages/modoki/tsconfig.check.json'
          : 'engine/tsconfig.app.json';
        const set = new Set(resolveConfigFiles(path.join(repoRoot, excludesTests)));
        expect(onDisk.some((f) => !set.has(f))).toBe(true);
      });

      it('includes EVERY test file in the typecheck program', () => {
        const set = new Set(covered);
        const missing = onDisk.filter((f) => !set.has(f)).map((f) => path.relative(repoRoot, f));
        // A failure here means those files are transpiled-but-never-typechecked again —
        // check the config's `include`, and whether an `exclude` (possibly INHERITED via
        // `extends`) is swallowing them.
        expect(missing).toEqual([]);
      });
    });
  }
});
