/** Guard: the MCP server must format every tool result through `result.ts`.
 *
 *  `mcpResult.test.ts` proves the FORMATTER is correct. This proves the server USES it —
 *  reverting to an inline `JSON.stringify(data, null, 2)` reintroduces the exact ~40%-overhead
 *  bug that work exists to kill, with all 20 formatter tests still green.
 *
 *  A source guard is the right shape here: the invariant IS a property of the source ("nobody
 *  hand-rolls a second serializer"), the same way `tests/runtime/determinismGuard.test.ts` scans
 *  `runtime/**` for wall-clock reads.
 *
 *  NOTE (E1, 2026-07-30): this file used to scan ONLY `index.ts`, because that module called
 *  `main()` at import and could not be loaded by a test. When the tool definitions moved into
 *  `tools/*.ts`, those scans silently found nothing — a text guard that loses its target fails
 *  OPEN. `sources()` now walks the whole tree, subdirectories included, so a hand-rolled
 *  serializer in a group module is caught too.
 *
 *  See `docs/mcp-response-budget.md` Phase 1. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/modoki-mcp/src');
const read = (f: string) => readScannedSource(path.join(SRC, f)).code;

/** Every `.ts` under `SRC`, recursively — SRC-relative paths, so failures name the file. Via
 *  the shared corpus producer (#799/#771/#805 Phase 4); `repoFiles()`'s own `rel` is
 *  repo-root-relative, so the prefix up to and including `SRC` is stripped by a plain string
 *  search, THROWING rather than tolerating a miss (same reasoning as
 *  `materialCloneStamp.test.ts`'s `runtimeFiles()`) — floored well under the 22 measured today. */
const SRC_PREFIX = 'engine/tools/modoki-mcp/src/';
const sources = (): string[] =>
  repoFiles({ under: SRC, match: /\.ts$/, floor: 15 }).map(({ rel }) => {
    if (!rel.startsWith(SRC_PREFIX)) {
      throw new Error(`mcpFormatterGuard: ${rel} is not under "${SRC_PREFIX}", but \`under\` is SRC.`);
    }
    return rel.slice(SRC_PREFIX.length);
  });

describe('MCP result formatting flows through result.ts', () => {
  it('the tool context builds its ok/err from createFormatter', () => {
    // Post-E1 this lives in `context.ts` (the factory every tool group is handed), not index.ts.
    const src = read('context.ts');
    expect(src).toMatch(/import\s*\{[^}]*createFormatter[^}]*\}\s*from\s*'\.\/result\.js'/);
    expect(src).toMatch(/createFormatter\(\s*\(\)\s*=>\s*identityWarning\s*\)/);
  });

  it('sources() actually finds the tool modules (this guard must not fail open)', () => {
    // The failure this file just lived through: every scan below is "the bad pattern is absent",
    // which passes trivially against an empty file list. Pin that the list is real.
    const found = sources();
    expect(found).toContain('context.ts');
    expect(found.filter((f) => f.startsWith('tools/')).length).toBeGreaterThanOrEqual(8);
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

  it('no module defines its own ok/err/banner', () => {
    // `const { ok, err } = createFormatter(...)` / `= ctx` is a destructure — allowed. A fresh
    // `const ok = (data) => ...` is a second, uncapped serializer — not.
    // `result.ts` is the DEFINITION site — `createFormatter` builds `banner`/`ok`/`err` there.
    // Everywhere else, defining one means a second uncapped serializer.
    for (const f of sources().filter((f) => f !== 'result.ts')) {
      const src = read(f);
      expect(src, f).not.toMatch(/const\s+ok\s*=\s*\(/);
      expect(src, f).not.toMatch(/const\s+err\s*=\s*\(/);
      expect(src, f).not.toMatch(/const\s+banner\s*=\s*\(/);
    }
  });

  it('result.ts stays free of the MCP SDK, so it remains unit-testable', () => {
    expect(read('result.ts')).not.toContain('@modelcontextprotocol');
  });
});
