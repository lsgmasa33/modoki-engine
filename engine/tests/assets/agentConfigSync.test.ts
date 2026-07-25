import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AGENT CONFIG SYNC GUARD — AGENTS.md (root + every games/<id>/demos/<id> + the
 * scaffolder template) and .cursor/mcp.json / .codex/config.toml are GENERATED from
 * CLAUDE.md / .mcp.json by engine/scripts/sync-agent-configs.mjs, so Cursor, Codex CLI,
 * and Antigravity CLI stay in lockstep with Claude Code's instructions and MCP wiring
 * without a git-tracked symlink (which silently degrades on Windows checkouts — see
 * docs/multi-ai-cli-support.md). This test fails if anyone edits CLAUDE.md / .mcp.json
 * without re-running `npm run sync:agent-configs`, or hand-edits a generated file directly.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptPath = path.join(repoRoot, 'engine/scripts/sync-agent-configs.mjs');

describe('agent config sync (AGENTS.md / .cursor/mcp.json / .codex/config.toml)', () => {
  it('generated files are up to date with CLAUDE.md and .mcp.json', () => {
    let output = '';
    try {
      output = execFileSync('node', [scriptPath, '--check'], { cwd: repoRoot, encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(
        `Generated agent config files are stale — run \`npm run sync:agent-configs\`:\n${e.stdout ?? ''}${e.stderr ?? ''}`,
      );
    }
    expect(output).toContain('up to date');
  });
});
