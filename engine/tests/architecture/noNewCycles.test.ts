import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeGraph, crossFolderValueCycles } from './moduleGraph';

/**
 * ARCHITECTURE RATCHET — see `docs/architecture-layers.md`. The runtime is a LAYERED module graph
 * (L0 core → L1 traits → L2 subsystems → L3 composition), not topic folders with no enforced
 * direction — cross-folder VALUE-import cycles are what accumulate when direction isn't enforced
 * (an ESM cycle doesn't error, it hands you `undefined` at module-eval time — the exact bug class
 * that produced "engine core depends on the Animation system").
 *
 * Type-only edges are excluded (see moduleGraph.ts's doc comment and architecture-layers.md's D2
 * decision) — `import type` / inline `type` specifiers are erased by `verbatimModuleSyntax` and
 * can never produce an ESM circular-init failure, so counting them would make this ratchet noisy
 * enough that someone eventually disables it.
 *
 * The module-boundaries layering work burned the cycle set down from an initial 20-entry baseline
 * to today's 2 entries (both very likely `moduleGraph.ts` folder-granularity artifacts — see
 * architecture-layers.md's "Known residue") via a burn-down allowlist in `engine/eslint.config.js`
 * that has since been deleted entirely — what's left here is the FROZEN, EXACT declared set — the
 * two tests below together enforce
 * equality (not just "no growth"): the first fails on a NEW cycle, the second fails on a STALE
 * baseline entry that no longer reproduces. If a future change removes one of these 2, prune its
 * entry from `cycles-baseline.json` in the same commit — leaving it in place with a comment
 * ("we don't hit this anymore") defeats the point of a machine-checked baseline. If a change
 * needs to ADD a cycle, that's a deliberate, reviewed exception — recompute the baseline with
 * moduleGraph.ts (never hand-edit) and say why in the commit message.
 */
const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cycles-baseline.json');
const baseline: string[] = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const baselineSet = new Set(baseline);

describe('runtime module layering — cross-folder cycle ratchet', () => {
  it('has no cross-folder VALUE-import cycle outside the committed baseline', () => {
    const edges = buildRuntimeGraph();
    const current = crossFolderValueCycles(edges);
    const newCycles = current.filter((c) => !baselineSet.has(c));
    expect(
      newCycles,
      `NEW cross-folder cycle(s) introduced — this is exactly the reverse-dependency class ` +
        `the layer contract (docs/architecture-layers.md) exists to stop. If this is a deliberate, reviewed exception, ` +
        `add it to cycles-baseline.json with a one-line reason in the same commit:\n${newCycles.join('\n')}`,
    ).toEqual([]);
  });

  it('the baseline has no stale entries (prune when a phase removes a cycle)', () => {
    const edges = buildRuntimeGraph();
    const current = new Set(crossFolderValueCycles(edges));
    const stale = baseline.filter((c) => !current.has(c));
    expect(
      stale,
      `cycles-baseline.json lists cycle(s) that no longer exist — shrink the baseline in the same ` +
        `commit that fixed them, don't let it drift stale:\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});
