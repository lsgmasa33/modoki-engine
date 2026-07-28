import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * BARREL SURFACE GUARD — see `docs/architecture-layers.md`. `runtime/index.ts` is the ONLY
 * public API `games/**`, `demos/**`, `engine/app/**` and the editor are meant to import through
 * (measured: they have ZERO deep imports into `runtime/**` internals — every layering phase was
 * free to move files around specifically BECAUSE those consumers only ever see this
 * barrel). This test is what makes that safe: it snapshots every VALUE name the barrel actually
 * exports at runtime, so a phase that reshuffles `runtime/` internals but silently drops or
 * renames an export gets caught immediately, instead of surfacing later as a mystifying
 * "`X` is not exported" in a game or the editor.
 *
 * Live import, not text-parsing: this dynamically imports the real `@modoki/engine/runtime`
 * entry point and reads `Object.keys(...)`, so it also happens to prove every export actually
 * evaluates to something (an `undefined` value would still appear as a present key here — the
 * dedicated liveness check that asserts VALUES, not just key presence, is Phase 2's job; this
 * test's job is narrower: the NAMES must not silently drift).
 *
 * Every phase of the plan preserves this exact export list — re-pointing what a name comes FROM
 * inside `runtime/` is fine and expected; changing WHAT names the barrel exposes is a deliberate,
 * reviewed decision and must update `barrel-surface-baseline.json` in the same commit with a
 * one-line reason, not as a side effect of an unrelated move.
 */
const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'barrel-surface-baseline.json');
const baseline: string[] = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

describe('runtime barrel surface (@modoki/engine/runtime)', () => {
  it('exports exactly the committed set of names', async () => {
    const mod = (await import('@modoki/engine/runtime')) as Record<string, unknown>;
    const current = Object.keys(mod).sort();
    const added = current.filter((k) => !baseline.includes(k));
    const removed = baseline.filter((k) => !current.includes(k));
    expect(
      { added, removed },
      `runtime/index.ts's export surface changed. If this is a deliberate, reviewed API change, ` +
        `update barrel-surface-baseline.json in the same commit with a one-line reason. If it is an ` +
        `accidental side effect of a file move, that move dropped or renamed an export games/demos/` +
        `the app may rely on — fix the move instead.`,
    ).toEqual({ added: [], removed: [] });
  });
});
