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
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../helpers/sourceScanner';

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
 *  `kind`/`what` tags, and failure codes. Anything else found in the module's source is copy. */
const ALLOWED_LITERALS = new Set<string>([
  // AccountProvider
  'apple', 'google', 'unknown',
  // AccountState kinds + `working.what`
  'signed-out', 'working', 'signing-in', 'signing-out', 'deleting', 'signed-in', 'error',
  // SignInFailure
  'network', 'not-configured', 'credential-in-use', 'failed',
]);

/** Every quoted/templated string literal in `code` (comments already stripped), excluding
 *  `import`/`export … from '<spec>'` module specifiers — a module path is not copy. */
function stringLiteralsIn(code: string): string[] {
  const withoutModuleSpecs = code.replace(/(\bfrom\s+)(['"`])(?:\\.|(?!\2).)*\2/g, '$1');
  const literals: string[] = [];
  const re = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutModuleSpecs)) !== null) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (text.length > 0) literals.push(text);
  }
  return literals;
}

describe('the engine account module carries no player-visible copy (#675)', () => {
  const files = accountSourceFiles(ACCOUNT_DIR);

  it('found the module — a guard that sweeps nothing proves nothing', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: every string literal is a type-union member, never copy`, () => {
      const raw = readFileSync(join(ACCOUNT_DIR, file), 'utf8');
      const code = stripComments(raw);
      const offenders = stringLiteralsIn(code).filter((s) => !ALLOWED_LITERALS.has(s));
      expect(offenders, `${file} contains string literal(s) that are not type-union members — this `
        + `module must carry no player-visible copy (#675):\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});

describe('the sweep does not stop at a subdirectory boundary (regression for the non-recursive hole)', () => {
  it('collects a nested file, and the guard\'s own literal check flags copy inside it', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'account-nocopy-fixture-'));
    try {
      mkdirSync(join(fixtureDir, 'copy'));
      const nestedFile = join(fixtureDir, 'copy', 'messages.ts');
      writeFileSync(nestedFile, "export const signInWithApple = 'Sign in with Apple';\n");
      writeFileSync(join(fixtureDir, 'index.ts'), "export const provider = 'apple';\n");

      const found = accountSourceFiles(fixtureDir);
      expect(found).toContain(join('copy', 'messages.ts'));

      const code = stripComments(readFileSync(nestedFile, 'utf8'));
      const offenders = stringLiteralsIn(code).filter((s) => !ALLOWED_LITERALS.has(s));
      expect(offenders).toEqual(['Sign in with Apple']);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
