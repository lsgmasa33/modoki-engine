/**
 * `wordbank/export.mjs` imports pure helpers straight out of `games/wordweave/runtime/*.ts`, and it
 * runs under Node's native type stripping — outside `npm test` and `verify` (see its README). So a
 * rename in one of those files breaks the exporter with nothing going red: #1318 removed `bandFor`
 * from `meter.ts`, and the exporter failed to link until a review ran it by hand.
 *
 * This reads the exporter's `../games/...` imports and asserts each named symbol is still exported,
 * and that each imported file has no relative import of its own (Node's type stripping would not
 * resolve an extensionless one, which is why those helpers are kept import-free).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasInternalGames } from '../helpers/repoLayout';
import { toPosix } from '../../scripts/pathPosix.mjs';

const REPO = path.resolve(__dirname, '../../..');
const EXPORTER = path.join(REPO, 'wordbank/export.mjs');

const gameImports = (): { names: string[]; file: string }[] => {
  const src = fs.readFileSync(EXPORTER, 'utf8');
  const out: { names: string[]; file: string }[] = [];
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'(\.\.\/games\/[^']+)';/gm)) {
    const names = m[1].split(',').map((n) => n.trim()).filter(Boolean);
    out.push({ names, file: path.resolve(path.dirname(EXPORTER), m[2]) });
  }
  return out;
};

// Private-only: the public snapshot ships neither wordbank/ nor games/wordweave. The parse is guarded
// too, because a skipped describe still runs its body to collect tests.
describe.skipIf(!hasInternalGames())('wordbank/export.mjs can still link against the game helpers it imports', () => {
  const imports = hasInternalGames() ? gameImports() : [];

  it('finds the game imports (the parse is not vacuous)', () => {
    // `toPosix` is load-bearing, not cosmetic: `path.relative` is backslash-separated on win32,
    // and this clone is the ONLY place this body runs — the public snapshot ships neither
    // wordbank/ nor games/wordweave, so the describe skips there and ci/main stayed green. #1435.
    expect(imports.map((i) => toPosix(path.relative(REPO, i.file))).sort()).toEqual([
      'games/wordweave/runtime/lemmaTable.ts',
      'games/wordweave/runtime/rarity.ts',
    ]);
  });

  for (const { names, file } of imports) {
    const rel = toPosix(path.relative(REPO, file));

    it(`${rel} still exports ${names.join(', ')}`, async () => {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const name of names) expect(mod[name], `${rel} no longer exports ${name}`).toBeDefined();
    });

    it(`${rel} has no relative import of its own`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const relative = [...src.matchAll(/^import\s[^;]*?from\s*'(\.[^']*)'/gm)]
        .filter((m) => !/^import\s+type\s/.test(m[0]))
        .map((m) => m[1]);
      expect(relative, `${rel} imports ${relative.join(', ')}`).toEqual([]);
    });
  }
});
