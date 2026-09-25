/**
 * Every `@modoki/engine/testing/*` helper that imports a Node builtin declares
 * `/// <reference types="node" />` ITSELF (#1544).
 *
 * A game's tsconfig loads `vite/client` types only, so a `node:*` import compiles only in a program
 * where SOME file carries that reference. Every established project had one by accident, in an
 * unrelated test, so a helper that relied on its importer compiled everywhere anyone looked — and a
 * freshly scaffolded project, whose program has no such file, failed its first build on
 * `tapTargetFloor.ts`. The reference is program-wide, so the helper declaring it also repairs every
 * project already scaffolded with the old template.
 *
 * The population is DERIVED from the package's `exports` map, not listed here: a helper exported
 * tomorrow is covered without an edit. Both halves are read the way the compiler reads them
 * (`ts.preProcessFile`), so a reference written after the first statement — which TypeScript
 * ignores — does not count.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'modoki');

/** `./testing` and `./testing/*` entries of the package's `exports`, as absolute file paths. */
function testingExports(): string[] {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
    exports: Record<string, string | Record<string, string>>;
  };
  return Object.entries(pkg.exports)
    .filter(([key]) => key === './testing' || key.startsWith('./testing/'))
    .map(([, target]) => join(PKG, typeof target === 'string' ? target : (target.import ?? target.default)));
}

const BUILTINS = new Set(builtinModules);
/** A Node builtin, with or without the `node:` prefix (`fs` is one, `fs/promises` is one). */
function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);
}

/** What the compiler sees: the file's imports, and the type references it honours. */
function scan(src: string) {
  const info = ts.preProcessFile(src, true, true);
  return {
    nodeImports: info.importedFiles.map((f) => f.fileName).filter(isNodeBuiltin),
    typeRefs: info.typeReferenceDirectives.map((r) => r.fileName),
  };
}

describe('@modoki/engine/testing helpers declare their own node types (#1544)', () => {
  const files = testingExports();

  it('finds the exported helpers — an empty population would pass every file vacuously', () => {
    // tapTargetFloor is the one a fresh scaffold imports, so it is the one that must be in here.
    expect(files.some((f) => f.endsWith('tapTargetFloor.ts'))).toBe(true);
    expect(files.length).toBeGreaterThan(5);
  });

  it('scan() reads a reference only where TypeScript honours it', () => {
    expect(scan('/// <reference types="node" />\nimport fs from "node:fs";\n'))
      .toEqual({ nodeImports: ['node:fs'], typeRefs: ['node'] });
    // After a statement it is an ordinary comment, which is why a text grep is not enough.
    expect(scan('import fs from "fs";\n/// <reference types="node" />\n').typeRefs).toEqual([]);
    expect(scan('import { x } from "vitest";\n').nodeImports).toEqual([]);
  });

  it('every one that imports a Node builtin carries `/// <reference types="node" />`', () => {
    const missing = files.filter((f) => {
      const { nodeImports, typeRefs } = scan(readFileSync(f, 'utf8'));
      return nodeImports.length > 0 && !typeRefs.includes('node');
    });
    expect(missing.map((f) => f.slice(PKG.length + 1)),
      'add `/// <reference types="node" />` as the FIRST line — a game that imports this helper '
      + 'otherwise fails its build unless some other file of its happens to carry it').toEqual([]);
  });
});
