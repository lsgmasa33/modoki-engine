/** No server may hand-roll the refusal-code extraction (#1211's class).
 *
 *  The rule the whole `family/agent-reply-code-lost` family rests on: **a layer relays the §5 code
 *  it was handed; it never invents one, and it never re-implements the check.** Five entries so far
 *  — #1012 (ops threw plain Errors so the route named the code), #1070 (the same hop again), #1013
 *  (`/api/eval`'s bare 504), #1223 P3 (the device wire), #1211 (the device MCP's own envelope
 *  sites) — and each was fixed by patching that hop, which is why there was always a next one.
 *
 *  What made #1211 possible was a COPY: `codeFromBody` lived inside `modoki-mcp/src/context.ts`, so
 *  the device server could not import it and open-coded the closed-set membership test instead
 *  (`device_dispatch_action`), while every other site skipped the check and stamped REFUSED_BY_OP.
 *  The helper now lives in `shared/mcpResult.ts`; this guard is what stops a sixth copy appearing
 *  next to it. */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';

/** The membership test itself — `ERROR_CODES … .includes(`, however it is spelled across lines. */
const OPEN_CODED = /ERROR_CODES[\s\S]{0,40}\.includes\s*\(/;

/** The two files allowed to run it, each because it OWNS a decode rather than consuming one.
 *  Anything else asks `codeFromBody` / `codeFromStatus`. */
const OWNERS = [
  'engine/tools/shared/errorCodes.ts',   // codeFromBody itself (split from mcpResult.ts, #1561)
  'engine/tools/shared/deviceRefusal.ts', // decodes the device wire's trailing line, not a body
];

/** ⚠️ KNOWN COPIES — a pardon, so it goes through `assertExemptionLedger` (#1140) rather than a
 *  hand-rolled filter: that helper is what makes a row that no longer matches anything FAIL, so a
 *  ledger cannot quietly become a blind spot.
 *
 *  These two are what this guard found on its FIRST run, which is the evidence that the copy shape
 *  spreads by itself: nobody wrote them to route around a rule, they were written because no shared
 *  helper was reachable. Both want "the code if it is a real one, otherwise nothing", which
 *  `codeFromBody` cannot express (it always returns a fallback), so migrating them needs a sibling
 *  — and that touches a module every server imports. Tracked on #1211 as the C-16 follow-up. */
const KNOWN_COPIES: ReadonlyArray<{ item: string; reason: string }> = [
  { item: 'engine/plugins/backend/deviceAim.ts', reason:
    'lifts a code onto a device refusal envelope; needs the optional-code sibling of codeFromBody (#1211 C-16 follow-up)' },
  { item: 'engine/plugins/backend/editorBackendRouter.ts', reason:
    'detects a coded refusal in an op result; same sibling (#1211 C-16 follow-up)' },
];

describe('the §5 refusal code is relayed, never re-derived', () => {
  it('only the shared decoders test the closed code set', () => {
    const files = repoFiles({
      under: ['engine/tools', 'engine/app', 'engine/plugins', 'engine/packages/modoki/src'],
      match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
      exclude: ['node_modules', 'dist'],
      floor: 0,
    });
    expect(files.length).toBeGreaterThan(200); // non-vacuity: the scan reached the servers
    assertExemptionLedger({
      label: 'KNOWN_COPIES in refusalCodeRelay',
      population: files
        .filter(({ abs }) => OPEN_CODED.test(readScannedSource(abs).code))
        .map(({ rel }) => ({ item: rel, site: rel })),
      // The two decoders are STRUCTURAL, not pardoned: they are the legitimate implementers of the
      // check, and a reviewer should not have to re-read that decision every time. Staleness-checked
      // all the same — a sanctioned name matching nothing is a claim with no subject.
      sanctioned: OWNERS,
      exempt: KNOWN_COPIES,
      // The two known copies ARE the floor: if the detector stops matching them it has broken, and
      // a silent zero would green every check below it.
      floor: KNOWN_COPIES.length + OWNERS.length,
      fix: 'this file open-codes the ERROR_CODES membership test. Ask codeFromBody() (or '
        + 'codeFromStatus()) from engine/tools/shared/mcpResult.ts instead — a layer relays the §5 '
        + 'code it was handed and never re-derives it. Five hops have been fixed one at a time '
        + '(#1012, #1070, #1013, #1223 P3, #1211) because each copy was written where no shared '
        + 'helper was reachable.',
    });
  });

  /** ⚠️ The guard above only catches a COPY of the check. It cannot catch the other half of the
   *  same defect — a site that never asks at all and writes `code: 'REFUSED_BY_OP'` over a reply it
   *  has in hand — because "has a body in hand" is not visible to a regex. That half is covered
   *  behaviourally, per tool, in `tests/tools/deviceRefusalCodeRelay.test.ts`, and this comment
   *  exists so the next reader does not mistake this file for the whole guard. */
  it('the behavioural half exists', () => {
    const files = repoFiles({
      under: ['engine/tests/tools'], match: (rel) => rel.endsWith('deviceRefusalCodeRelay.test.ts'),
      exclude: [], floor: 1,
    });
    expect(files).toHaveLength(1);
  });
});
