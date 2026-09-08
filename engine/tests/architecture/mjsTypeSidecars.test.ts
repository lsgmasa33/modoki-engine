/** Guard: every `.d.mts` type sidecar declares exactly the value exports its `.mjs` has.
 *
 *  `engine/scripts/**` ships plain `.mjs` build scripts that TS cannot infer types for, so
 *  each one that a typechecked consumer imports gets a HAND-WRITTEN `.d.mts` sitting beside
 *  it (the convention `schema.d.mts` established). Hand-written is the problem: nothing ties
 *  the declaration to the implementation, so the two drift silently and the typechecker
 *  confidently reports against a signature that no longer exists.
 *
 *  That is not hypothetical. When issue #23 replaced a set of wildcard `declare module` glob
 *  blocks with these sidecars, writing them against the real code immediately turned up drift:
 *  `signRelease` had been declared generic (`<T extends object>(r: T) => T & { sig }`) when the
 *  real function only ever operates on the OTA release shape. A wildcard ambient can be wrong
 *  forever; this guard makes a sidecar wrong for exactly one commit.
 *
 *  Scope note — this checks the export SET, not signatures. Verifying parameter and return
 *  types against untyped JS is what the sidecar exists to assert in the first place, so there
 *  is nothing to compare them to. Renaming, adding, or deleting an export is the drift that
 *  actually happens (and the one that produces a confusing "has no exported member" at a call
 *  site far away), and that is what this catches. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const scriptsDir = path.resolve(__dirname, '../../scripts');

/** Every `.d.mts` under engine/scripts/, paired with the `.mjs` it describes — via the shared
 *  corpus producer (#799/#771/#805 Phase 4). Floored well under the 28 measured today. */
function sidecarPairs(): { decl: string; impl: string }[] {
  return repoFiles({ under: scriptsDir, match: /\.d\.mts$/, exclude: ['node_modules'], floor: 10 })
    .map(({ abs }) => ({ decl: abs, impl: abs.replace(/\.d\.mts$/, '.mjs') }));
}

/** Names exported as VALUES (functions, consts) — deliberately excluding type-only exports
 *  (`export interface` / `export type`), which have no runtime counterpart to compare against. */
function valueExports(file: string): string[] {
  const src = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2023,
    /* setParentNodes */ true,
  );
  const names = new Set<string>();
  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const stmt of src.statements) {
    if (ts.isFunctionDeclaration(stmt) && isExported(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text);
      }
    } else if (ts.isClassDeclaration(stmt) && isExported(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      // `export { a, b }` — skip `export type { … }` and per-specifier `type` markers.
      if (stmt.isTypeOnly) continue;
      for (const spec of stmt.exportClause.elements) {
        if (!spec.isTypeOnly) names.add(spec.name.text);
      }
    }
  }
  return [...names].sort();
}

describe('.d.mts sidecars match their .mjs (issue #23)', () => {
  const pairs = sidecarPairs();

  it('finds the sidecars (the walk is not silently empty)', () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  for (const { decl, impl } of pairs) {
    const rel = path.relative(scriptsDir, decl);

    describe(rel, () => {
      it('sits beside the .mjs it declares', () => {
        expect(fs.existsSync(impl), `${rel} has no sibling ${path.basename(impl)}`).toBe(true);
      });

      it('declares exactly the .mjs value exports — no more, no fewer', () => {
        if (!fs.existsSync(impl)) return; // reported by the test above
        // Missing ⇒ a consumer gets "has no exported member" for something that exists.
        // Extra ⇒ worse: it typechecks against an export that was renamed or deleted, and
        // fails at RUNTIME instead. Both are drift; assert the sets are equal.
        expect(valueExports(decl)).toEqual(valueExports(impl));
      });
    });
  }
});
