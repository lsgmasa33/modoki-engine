/** The cause LABELS exist in three zones, and two of them can be compared (#972 close-out review).
 *
 *  `CAUSE_SPECS[k].label` (`editor/scene/serialize.ts`) and `CAUSE_LABELS` (`app/debug/hmrStaleness.ts`)
 *  carry byte-identical human phrasing for the same five causes, hand-synced with nothing pinning
 *  them. That is `CLAUDE.md`'s shadowing-constant hazard exactly: rename "pending import-setting
 *  edit" in the table and `discard_asset_edits` says the new wording while the HMR reload banner
 *  keeps the old one, with nothing red.
 *
 *  ⚠️ **Why a cross-check and not deduplication.** `hmrStaleness.ts` must not import the editor
 *  barrel statically — it runs on a plain game page where that barrel must never enter the bundle,
 *  which is why it reaches for the causes through a guarded dynamic `import()` and types them
 *  loosely on purpose (`docs/mcp-persistence.md` § "The cause table is the SCHEMA"). Sourcing its
 *  labels from `causeSpecs()` at probe time would also make the banner's WORDING depend on whether
 *  that import resolved, and silently humanize every label under an injected probe. So the
 *  duplication stays and this asserts the two copies agree.
 *
 *  This is NOT a third copy: it compares two live values and writes neither. A guard that restated
 *  the phrases as literals would be the very thing it is meant to prevent.
 *
 *  The MCP bundle's `CAUSE_PHRASES` is a third instance and is deliberately NOT checked here — it
 *  is a separate process that genuinely cannot import either module, its sentences are whole
 *  agent-facing phrasings rather than nouns, and it is expected to drift from a NEWER renderer by
 *  design. Its safety net is the humanize fallback, not agreement.
 */

import { describe, it, expect } from 'vitest';
import { causeSpecs } from '../../packages/modoki/src/editor/scene/serialize';
import { CAUSE_LABELS } from '../../app/debug/hmrStaleness';

describe('the two in-bundle copies of the cause labels agree', () => {
  it('every cause the table declares has the same phrasing in the HMR banner', () => {
    const fromTable = Object.fromEntries(
      Object.entries(causeSpecs()).map(([key, spec]) => [key, { ...spec.label }]),
    );
    // Non-vacuity: an empty comparison would pass forever.
    expect(Object.keys(fromTable).length, 'the cause table is empty — this guard has no subject')
      .toBeGreaterThanOrEqual(5);
    expect(CAUSE_LABELS).toEqual(fromTable);
  });

  it('the HMR banner names no cause the table does not have', () => {
    // The other direction. A label left behind after a cause is REMOVED is dead phrasing that
    // still reads as current to the next person editing this file.
    expect(Object.keys(CAUSE_LABELS).sort()).toEqual(Object.keys(causeSpecs()).sort());
  });
});
