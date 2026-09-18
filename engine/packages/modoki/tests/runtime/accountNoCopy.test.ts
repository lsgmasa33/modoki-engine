/**
 * Guard: the account module (`src/runtime/account/**`, #675) carries account-generic DECISIONS,
 * never player-visible copy — the owner's ruling (2026-09-04) that narrowed #675 to types +
 * `reauthProviderFor` only, explicitly to avoid "an engine module that hardcodes English", which
 * the issue called worse than a duplicated one: it is a localisation blocker in a place a game
 * cannot reach. Every OTHER string builder (`providerLine`, `signInErrorText`, `syncLine`,
 * `accountRows`, …) stayed in Court's `runtime/accountUi.ts` on purpose.
 *
 * Mechanical and deliberately simple, per the brief: strip import/export module specifiers (a
 * path is not copy), strip comments with the shared scanner (#419 — never write a private one),
 * then every remaining quoted or templated string literal in the module's source must be one of
 * the type unions' own members — a provider id, a state `kind`/`what`, or a failure code. Nothing
 * else is allowed to appear, because nothing else should need translation from a place a game
 * cannot reach.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import { fileURLToPath } from 'node:url';
import { stripComments } from '../helpers/sourceScanner';
import { parseSource, ts } from '../helpers/sourceAst';
import { assertExemptionLedger } from '../helpers/exemptionLedger';
import { makeScratchDir } from '../helpers/scratchDir';

const ACCOUNT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../src/runtime/account');

/** Every `.ts`/`.tsx` file under `dir`, recursively (a nested file — e.g. an `account/copy/`
 *  subdirectory — carries copy exactly as easily as a top-level one, so the sweep must not stop
 *  at a directory boundary), excluding test files and directory entries themselves. Exported so
 *  the fixture test below can pin the recursive behaviour against a throwaway directory instead
 *  of the real source tree. */
export function accountSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

/** Every string the type unions in `types.ts` actually use as a member — provider ids, state
 *  `kind`/`what` tags, and failure codes. Anything else found in the module's source is copy.
 *
 *  ⚠️ **Passed to the ledger as `sanctioned`, not tested with `.has()` (#1140).** A union member is
 *  a TOKEN-level pardon on purpose — `'apple'` is never copy however often it appears — so it is not
 *  counted. What the bare `Set` lacked was any staleness check; `sanctioned` requires each name to
 *  still appear SOMEWHERE in the module. ⚠️ That is weaker than "still a union member": `types.ts`
 *  is inside the scan, so a name goes stale only once it is neither declared in a union NOR written
 *  anywhere else in the module — a member dropped from its union but still spelled as a string in
 *  `index.ts` keeps its pardon (review, #1140 close-out). */
const ALLOWED_LITERALS: readonly string[] = [
  // AccountProvider
  'apple', 'google', 'unknown',
  // AccountState kinds + `working.what`
  'signed-out', 'working', 'signing-in', 'signing-out', 'deleting', 'signed-in', 'error',
  // SignInFailure
  'network', 'not-configured', 'credential-in-use', 'failed',
  // SupportId kinds (#1398)
  'account', 'install', 'none',
];

/** Every quoted/templated string literal in `code` (comments already stripped), excluding module
 *  specifiers — a module path is not copy. A template with substitutions counts once, as its whole text.
 *
 *  Read from the parse (#1193). This was a regex that blanked `from '<spec>'` and then tokenised quotes by
 *  hand, so a specifier in `import '…'`, `import('…')` or `import x = require('…')` read as copy, and a
 *  quote inside a template's `${…}` split it. Same 20 literals over the module on 2026-09-15. */
function stringLiteralsIn(code: string, label = 'account.ts'): string[] {
  const sf = parseSource(code, label);
  const literals: string[] = [];
  const isModuleSpecifier = (n: ts.Node): boolean => {
    const p = n.parent;
    return ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === n)
      || ts.isExternalModuleReference(p)
      || (ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword)
      || (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent));
  };
  const visit = (n: ts.Node): void => {
    if (ts.isTemplateExpression(n)) { literals.push(n.getText(sf).slice(1, -1)); return; }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !isModuleSpecifier(n)) {
      const text = n.getText(sf).slice(1, -1);
      if (text.length > 0) literals.push(text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return literals;
}

describe('the engine account module carries no player-visible copy (#675)', () => {
  const files = accountSourceFiles(ACCOUNT_DIR);

  it('found the module — a guard that sweeps nothing proves nothing', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every string literal in the module is a type-union member, never copy — and every member is still used', () => {
    assertExemptionLedger({
      label: 'ALLOWED_LITERALS in accountNoCopy',
      population: files.flatMap((file) => stringLiteralsIn(stripComments(readFileSync(join(ACCOUNT_DIR, file), 'utf8')), file)
        .map((literal) => ({ item: literal, site: `${file}: ${JSON.stringify(literal)}` }))),
      sanctioned: ALLOWED_LITERALS,
      floor: 1,
      fix: 'these string literal(s) are not type-union members — the account module must carry no '
        + 'player-visible copy (#675). Move the string to the game (Court\'s runtime/accountUi.ts).',
    });
  });
});

describe('the sweep does not stop at a subdirectory boundary (regression for the non-recursive hole)', () => {
  it('collects a nested file, and the guard\'s own literal check flags copy inside it', () => {
    const fixtureDir = makeScratchDir('account-nocopy-fixture-');
    try {
      mkdirSync(join(fixtureDir, 'copy'));
      const nestedFile = join(fixtureDir, 'copy', 'messages.ts');
      writeFileSync(nestedFile, "export const signInWithApple = 'Sign in with Apple';\n");
      writeFileSync(join(fixtureDir, 'index.ts'), "export const provider = 'apple';\n");

      const found = accountSourceFiles(fixtureDir);
      expect(found).toContain(join('copy', 'messages.ts'));

      const code = stripComments(readFileSync(nestedFile, 'utf8'));
      // The nested file's only literal is copy — not a union member — so the scan must report it.
      expect(stringLiteralsIn(code, 'messages.ts')).toEqual(['Sign in with Apple']);
      // …and a module specifier in any spelling is not copy (#1193), while a string beside it still is.
      expect(stringLiteralsIn([
        "import './copy/sideEffect';",
        "import x = require('./copy/required');",
        "export * from './copy/reexported';",
        "type T = import('./copy/typed').T;",
        "const lazy = () => import('./copy/dynamic');",
        "const label = `Hello ${'there'}`;",
      ].join('\n'), 'fixture.ts')).toEqual(["Hello ${'there'}"]);
      expect(ALLOWED_LITERALS).not.toContain('Sign in with Apple');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
