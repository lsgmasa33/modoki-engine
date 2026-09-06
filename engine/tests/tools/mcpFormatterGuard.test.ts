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

/** The MCP servers, DERIVED from the marker every one of them has: its own `src/result.ts`.
 *
 *  ⚠️ **This used to be `const SRC = …/modoki-mcp/src` — one server, hardcoded, while there are
 *  TWO (#829).** The docblock above says "the MCP server must format every tool result through
 *  `result.ts`" and the note about `sources()` walking "the whole tree" is true only of the tree
 *  it was pointed at. `game-debug-mcp` was never read, and it contained the regression this file
 *  exists to catch, verbatim, at `mcp-tools.ts:2167`:
 *
 *      text: note + JSON.stringify(result, null, 2)
 *
 *  A green run meant "clean inside one of two servers", and nothing said so. Deriving the list
 *  from `result.ts` means a third server is covered the day it is created. */
const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');

interface Server { id: string; srcDir: string; prefix: string }

function servers(): Server[] {
  const found = repoFiles({ under: 'engine/tools', match: /\/src\/result\.ts$/, floor: 2 })
    .map(({ rel }) => rel.replace(/\/result\.ts$/, ''))
    .sort();
  return found.map((prefix) => ({
    id: prefix.split('/')[2],
    srcDir: path.join(TOOLS_DIR, prefix.replace('engine/tools/', '')),
    prefix: `${prefix}/`,
  }));
}

/** Every `.ts` under one server's `src`, as server-relative paths so a failure names the file. */
function sourcesOf(server: Server): string[] {
  return repoFiles({ under: server.srcDir, match: /\.ts$/, floor: 4 }).map(({ rel }) => {
    if (!rel.startsWith(server.prefix)) {
      throw new Error(`mcpFormatterGuard: ${rel} is not under "${server.prefix}".`);
    }
    return rel.slice(server.prefix.length);
  });
}

const readIn = (server: Server, f: string) => readScannedSource(path.join(server.srcDir, f)).code;

describe('MCP result formatting flows through result.ts', () => {
  const ALL = servers();

  it('finds every MCP server by its result.ts marker — a miss here fails the suite OPEN', () => {
    // Non-vacuity, NOT a frozen roster. `describe.each(ALL)` below applies every shared assertion
    // to whatever this returns, so a third server is covered the day it is created and pinning an
    // exact list would only add a merge conflict for the branch that adds one. What must not
    // happen silently is the marker glob breaking and this returning one server (or none) — which
    // is precisely the state #829 was in, and nothing noticed for months.
    const ids = ALL.map((s) => s.id);
    expect(ids.length, 'fewer than two MCP servers found by the src/result.ts marker — the glob '
      + 'has broken, and every per-server assertion below would pass having read nothing')
      .toBeGreaterThanOrEqual(2);
    expect(ids).toEqual(expect.arrayContaining(['game-debug-mcp', 'modoki-mcp']));
  });

  describe.each(ALL)('$id', (server) => {
    it('sources() actually finds the tool modules (this guard must not fail open)', () => {
      // Non-vacuity per server, floored under each one's real count (22 and 5 today). The
      // aggregate is useless here: modoki-mcp alone would satisfy any combined floor while
      // game-debug-mcp contributed nothing, which is the shape of the bug this file just had.
      expect(sourcesOf(server).length).toBeGreaterThanOrEqual(4);
      expect(sourcesOf(server)).toContain('result.ts');
    });

    it('no module hand-rolls a pretty-printed serializer', () => {
      // The regression, verbatim: `JSON.stringify(data, null, 2)`. Match any indent argument, in
      // any source file, so a "helpful" reintroduction anywhere in the server is caught. Read
      // through the shared scanner, so the two mentions in game-debug-mcp's own result.ts
      // docblock — which DESCRIBE the defect — are comments and cannot trip it.
      const offenders = sourcesOf(server)
        .map((f) => [f, readIn(server, f)] as const)
        .filter(([, src]) => /JSON\.stringify\([^)]*,\s*null\s*,\s*\d+\s*\)/.test(src))
        .map(([f]) => f);
      expect(offenders, `${server.id}: these modules pretty-print their own result instead of `
        + 'going through result.ts. That is the ~40% indentation overhead the response-budget '
        + 'work exists to kill, and it is uncapped — see docs/mcp-response-budget.md Phase 1.')
        .toEqual([]);
    });

    it('no module defines its own ok/err/banner', () => {
      // A destructure (`const { ok, err } = ctx`) is allowed; a fresh `const ok = (data) => …` is
      // a second, uncapped serializer. `result.ts` is the DEFINITION site and is exempt.
      for (const f of sourcesOf(server).filter((f) => f !== 'result.ts')) {
        const src = readIn(server, f);
        expect(src, `${server.id}/${f}`).not.toMatch(/const\s+ok\s*=\s*\(/);
        expect(src, `${server.id}/${f}`).not.toMatch(/const\s+err\s*=\s*\(/);
        expect(src, `${server.id}/${f}`).not.toMatch(/const\s+banner\s*=\s*\(/);
      }
    });

    it('result.ts stays free of the MCP SDK, so it remains unit-testable', () => {
      expect(readIn(server, 'result.ts')).not.toContain('@modelcontextprotocol');
    });
  });

  /* ---------------------------------------------------------------- modoki-mcp's own architecture */

  it('modoki-mcp: the tool context builds its ok/err from createFormatter', () => {
    // ⚠️ SCOPED TO ONE SERVER ON PURPOSE, and the reason is the point of #829: the two servers do
    // not share this abstraction. `modoki-mcp/src/result.ts` exports exactly `createFormatter`,
    // which a `context.ts` hands to every tool group. `game-debug-mcp/src/result.ts` exports a
    // different surface entirely — `deviceFail`, `caughtFailure`, `encodeStructuredResult`,
    // `capText` — and has no `context.ts` at all. Running this assertion over both would fail on
    // a server whose architecture is legitimately different, which is how a widened guard gets
    // relaxed back to uselessness. The invariants that ARE shared are the four above.
    const modoki = ALL.find((s) => s.id === 'modoki-mcp');
    expect(modoki, 'modoki-mcp not found by the result.ts marker').toBeDefined();
    const src = readIn(modoki!, 'context.ts');
    expect(src).toContain('createFormatter');
  });
});
