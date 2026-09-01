import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MEMORY INDEX SYNC GUARD — .agent-memory/MEMORY.md is GENERATED from each memory file's
 * frontmatter by scripts/gen-memory-index.mjs. Its header always CLAIMED to be generated;
 * for a long time it was not, and six clones hand-inserting entries in six different orders
 * made it the single most conflicted file in the repo (10 of ~34 conflicted files across
 * the last 40 hub merges). `merge=union` cannot fix that shape — both sides hold the same
 * entries at different positions, so union duplicates them. Deterministic generation can:
 * the same set of memory files yields a byte-identical index on every clone.
 *
 * This test fails if anyone adds/edits a memory without re-running the generator, or
 * hand-edits MEMORY.md directly. It also fails on a memory whose frontmatter is missing
 * `metadata.category`, because an uncategorised memory would silently vanish from the index.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptPath = path.join(repoRoot, 'scripts/gen-memory-index.mjs');

describe('memory index sync (.agent-memory/MEMORY.md)', () => {
  it('MEMORY.md is up to date with the memory frontmatter', () => {
    let output: string;
    try {
      output = execFileSync('node', [scriptPath, '--check'], { cwd: repoRoot, encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(
        `.agent-memory/MEMORY.md is stale — run \`npm run gen:memory-index\`:\n${e.stdout ?? ''}${e.stderr ?? ''}`,
        { cause: err },
      );
    }
    expect(output).toContain('up to date');
  });
});
