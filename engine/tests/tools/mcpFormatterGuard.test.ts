/** Guard: the MCP server must format every tool result through `result.ts`.
 *
 *  `mcpResult.test.ts` proves the FORMATTER is correct. It cannot prove `index.ts` USES it —
 *  index.ts calls `main()` at module load, so vitest can't import it, and the one end-to-end
 *  check (`npm run smoke:mcp`) needs a live editor and is deliberately out of CI. That left the
 *  shipping code path unguarded: reverting `index.ts` to its old inline
 *  `JSON.stringify(data, null, 2)` reintroduces the exact ~40%-overhead bug this work exists to
 *  kill, with all 20 formatter tests still green.
 *
 *  So we scan the source, the same way `tests/runtime/determinismGuard.test.ts` scans `runtime/**`
 *  for wall-clock reads. A source guard is the right shape here: the invariant IS a property of
 *  the source ("nobody hand-rolls a second serializer"), and it costs nothing to enforce.
 *
 *  See `docs/mcp-response-budget.md` Phase 1. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/modoki-mcp/src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf-8');
const sources = () => fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));

describe('MCP result formatting flows through result.ts', () => {
  it('index.ts builds its ok/err from createFormatter', () => {
    const src = read('index.ts');
    expect(src).toMatch(/import\s*\{[^}]*createFormatter[^}]*\}\s*from\s*'\.\/result\.js'/);
    expect(src).toMatch(/createFormatter\(\s*\(\)\s*=>\s*identityWarning\s*\)/);
  });

  it('no module hand-rolls a pretty-printed serializer', () => {
    // The regression, verbatim: `JSON.stringify(data, null, 2)`. Match any indent argument, in
    // any source file, so a "helpful" reintroduction anywhere in the server is caught.
    const offenders = sources()
      .map((f) => [f, read(f)] as const)
      .filter(([, src]) => /JSON\.stringify\([^)]*,\s*null\s*,\s*\d+\s*\)/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('index.ts does not define its own ok/err/banner', () => {
    const src = read('index.ts');
    // `const { ok, err } = createFormatter(...)` is the destructure — allowed. A fresh
    // `const ok = (data) => ...` is a second, uncapped serializer — not.
    expect(src).not.toMatch(/const\s+ok\s*=\s*\(/);
    expect(src).not.toMatch(/const\s+err\s*=\s*\(/);
    expect(src).not.toMatch(/const\s+banner\s*=\s*\(/);
  });

  it('result.ts stays free of the MCP SDK, so it remains unit-testable', () => {
    expect(read('result.ts')).not.toContain('@modelcontextprotocol');
  });
});
