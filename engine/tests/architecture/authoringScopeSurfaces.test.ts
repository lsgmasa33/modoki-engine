/** The surfaces that tell a user "this gesture left runtime entities out" (#1301/#1306).
 *
 *  Two guards, both about the SAME risk: the report exists in more than one place, and the copies
 *  drift. `runtimeExcludedMessage` (`editor/scene/authoringScope.ts`) is the one wording; the
 *  console line, both Create Prefab toasts, the agent `prefab create` op and the prefab-edit save
 *  all call it. For about an hour three of those carried hand-written sentences while the helper's
 *  own docblock claimed to be the single source — nothing failed, because nothing was watching.
 *
 *  ⚠️ Both read through `readScannedSource`, so a match is CODE, never a comment. The first cut of
 *  these guards used `fs.readFileSync` and matched raw text — which `commentStripperIsShared`
 *  (#812) rejected, correctly: this file's own prose quotes the sentence it forbids, so a raw-text
 *  version would have flagged itself, and a duplicate hidden in a comment would have satisfied the
 *  other one. They also hand-rolled a `readdirSync` walk, which `corpusProducerIsShared`
 *  (#799/#771/#805) rejected for the same class of reason. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');
/** ⚠️ The SUBJECT, not the full sentence. An earlier cut matched the message's tail clause verbatim,
 *  and the re-review measured what that was worth: of the three hand-written wordings the collapse
 *  removed, ZERO contained it ("generated at runtime **and are** not authored content", and twice
 *  "not **authored.**"). It caught only a verbatim re-paste — which is exactly what its own
 *  mutation check had used, so the check passed on a non-unique anchor and proved nothing.
 *
 *  Matching `runtime entit` in CODE (comments stripped) catches a reworded copy too, because every
 *  wording of this report has to name the thing it is counting. */
const CLAUSE = 'runtime entit';
const OWNER = 'engine/packages/modoki/src/editor/scene/authoringScope.ts';

describe('the runtime-exclusion report has ONE wording', () => {
  it('is written in exactly one file — the helper that owns it', () => {
    // Wider than the two roots the first cut scanned: an MCP response builder or an Electron menu
    // is a plausible fifth home for this sentence, and neither was in reach (re-review finding 4).
    const files = repoFiles({
      under: [
        'engine/packages/modoki/src/editor', 'engine/packages/modoki/src/runtime',
        'engine/app', 'engine/tools/modoki-mcp/src', 'engine/electron',
      ],
      match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
      exclude: ['node_modules', 'dist'],
      floor: 0,
    });
    expect(files.length).toBeGreaterThan(200); // non-vacuity: the scan really reached those trees
    const offenders = files
      .filter(({ rel }) => rel !== OWNER)
      .filter(({ abs }) => readScannedSource(abs).code.includes(CLAUSE))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

describe('the prefab-edit save reports its exclusions', () => {
  /** ⚠️ A SOURCE-SHAPE guard, and weaker than a behavioural one — it proves the wiring is present,
   *  not that it fires. `savePrefabEdit` has no harness (it needs the prefab cache, the
   *  editing-prefab state, a write fetch and the edit-version clock) and building one for a warning
   *  line is out of proportion; `warnInertPrefabSizes.test.ts` guards the sibling rule on this same
   *  function the same way.
   *
   *  Worth having because the loss is silent: editing a prefab that contains a UIScrollView spawns
   *  pooled rows INSIDE the prefab-edit world, so that save legitimately drops them — and its
   *  caller, the agent `edit-save` op, reads `warnings` and never the console. Measured: deleting
   *  the push left the whole package suite green. */
  it('passes onRuntimeExcluded and pushes the message into the warnings the agent op reads', () => {
    const { code } = readScannedSource(path.join(REPO, 'engine/packages/modoki/src/editor/scene/prefabEdit.ts'));
    // ⚠️ Both patterns tie the VALUE to the variable, rather than just proving the two names appear
    // near each other. The first cut allowed `onRuntimeExcluded: (n) => { void n; }` and any
    // `warnings.push(runtimeExcludedMessage(...))` of anything — wiring that reports zero would
    // have passed it. It also anchored on a 400-character window from the `serializePrefab(` call,
    // with 263 to spare: one docblock inside that option object (routine in this file) would have
    // turned a correct change red.
    expect(code).toMatch(/onRuntimeExcluded:\s*\(\s*n\s*\)\s*=>\s*\{\s*runtimeExcluded\s*=\s*n\s*;?\s*\}/);
    expect(code).toMatch(/warnings\.push\(runtimeExcludedMessage\(runtimeExcluded\)\)/);
  });
});
