/** Phase 9 — the generated tool catalog in `docs/debug-tools-mcp.md` must match `contracts.ts`.
 *
 *  WHY A TEST AND NOT A CONVENTION. The catalog is one row per tool of fact — endpoint, mutating,
 *  undoable, requirements, aim, smallest valid call. Restated by hand, every one of those is a fact
 *  that can go stale silently, and a stale doc on THIS surface is not cosmetic: an agent reads it and
 *  calls the wrong thing. `docs/doc-conventions.md` already says a fact lives in ONE place; this is
 *  what makes that enforceable rather than aspirational.
 *
 *  The guard compares the doc against the SAME render function the generator writes with, so it
 *  cannot pass by testing a second implementation of the table (conventions §9). Fixing a failure is
 *  one command — `npm --prefix engine/tools/modoki-mcp run gen:catalog` — which the failure message
 *  says.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS } from '../../tools/modoki-mcp/src/contracts';
import { renderCatalog, extractCatalog, CATALOG_BEGIN, CATALOG_END } from '../../tools/modoki-mcp/src/toolCatalog';

const DOC = join(__dirname, '../../../docs/debug-tools-mcp.md');
// Normalise CRLF → LF. `renderCatalog()` emits \n, so on a checkout where this .md landed with
// CRLF the comparison below fails showing two strings that look CHARACTER-FOR-CHARACTER
// IDENTICAL in the diff — which is how it presented on the public repo's Windows leg, where the
// snapshot ships no line-ending pins of its own (see oss/.gitattributes). The pins fix the
// checkout; this makes the test correct regardless of how any checkout is configured.
const doc = readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');

describe('the generated tool catalog is in sync with the contract table', () => {
  it('the markers are present, exactly once each', () => {
    // Duplicated markers would let the generator write into one block while a reader reads the
    // other — a stale catalog that no diff makes obvious.
    expect(doc.split(CATALOG_BEGIN).length - 1, 'BEGIN marker count').toBe(1);
    expect(doc.split(CATALOG_END).length - 1, 'END marker count').toBe(1);
  });

  it('the table matches what the contract table renders TODAY', () => {
    expect(extractCatalog(doc).trim(),
      'the catalog in docs/debug-tools-mcp.md is stale. Run: '
      + 'npm --prefix engine/tools/modoki-mcp run gen:catalog').toBe(renderCatalog().trim());
  });

  it('every tool appears exactly once in the rendered table', () => {
    // The kind-grouped layout means a tool with an unexpected `kind` could silently fall out of
    // every group. Assert coverage rather than trusting the grouping.
    const rendered = renderCatalog();
    const missing = Object.keys(CONTRACTS).filter((n) => !rendered.includes(`\`${n}\``));
    expect(missing, 'tools absent from the catalog (an unhandled `kind`?)').toEqual([]);
    for (const n of Object.keys(CONTRACTS)) {
      const hits = rendered.split(`| \`${n}\` |`).length - 1;
      expect(hits, `${n} appears ${hits} times as a row`).toBe(1);
    }
  });

  it('the rendered `Smallest call` is the SAME object the tests and the live sweep use', () => {
    // The table's copy-paste value depends on this: it is `minimalArgs`, verbatim, which
    // `mcpToolContracts` validates against each tool's own schema and the live sweep actually calls.
    // If this ever became a hand-written "example", it would rot like any other restated fact.
    const rendered = renderCatalog();
    for (const [name, c] of Object.entries(CONTRACTS)) {
      const args = c.minimalArgs ?? {};
      if (!Object.keys(args).length) continue;
      expect(rendered, `${name}'s smallest call`).toContain(`\`${JSON.stringify(args)}\``);
    }
  });

  it('an IMPURE READ is flagged in the table, not just in the prose', () => {
    // `modoki_journal` / `modoki_editor_journal` sit under a heading that says "never changes
    // anything". A reader skimming rows must still see that an optional arg destroys state.
    const rendered = renderCatalog();
    for (const [name, c] of Object.entries(CONTRACTS)) {
      if (c.kind !== 'read' || !c.mutating) continue;
      const row = rendered.split('\n').find((l) => l.startsWith(`| \`${name}\` |`))!;
      expect(row, `${name} is an impure read and must say so`).toContain('IMPURE READ');
    }
  });

  it('…and the sync check can FAIL (it is compared, not merely regenerated)', () => {
    // Mutation test: a guard that regenerates and compares against itself always passes.
    expect(extractCatalog(doc).trim()).not.toBe(renderCatalog().trim().replace('modoki_batch', 'modoki_bacth'));
  });
});
