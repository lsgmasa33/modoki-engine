#!/usr/bin/env node
/**
 * Generates AI-tool-agnostic config files from their single sources of truth:
 *   - AGENTS.md            (from CLAUDE.md) — read natively by Cursor, Codex CLI, and
 *                            Antigravity CLI (root + every games/<id>/demos/<id> project +
 *                            the scaffolder template, mirroring CLAUDE.md's own footprint).
 *   - .cursor/mcp.json     (from .mcp.json) — Cursor's MCP server config (same JSON shape).
 *   - .codex/config.toml   (from .mcp.json) — Codex CLI's MCP server config (TOML).
 *
 * These are GENERATED files — never hand-edit them. Edit CLAUDE.md / .mcp.json, then run:
 *   npm run sync:agent-configs
 *
 * Antigravity CLI's own mcp_config.json is intentionally NOT generated here — its schema
 * and file locations are still new/evolving (differ between the CLI and IDE as of 2026-07).
 * See docs/multi-ai-cli-support.md.
 *
 * Run with --check to verify everything is up to date without writing (used by
 * engine/tests/assets/agentConfigSync.test.ts); exits non-zero and lists stale files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverProjects } from './projectRoots.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');

const AGENTS_HEADER =
  '<!-- Generated from CLAUDE.md by `npm run sync:agent-configs` — edit CLAUDE.md, not this file. -->\n\n';

/** Every directory that should get a generated AGENTS.md sibling: repo root, every
 *  games/<id> + demos/<id> project that has a CLAUDE.md, and the scaffolder template. */
function agentsMdTargetDirs() {
  const dirs = [
    repoRoot,
    ...discoverProjects(repoRoot).map((p) => p.dir),
    path.join(repoRoot, 'engine/templates/starter'),
  ];
  return dirs.filter((dir) => fs.existsSync(path.join(dir, 'CLAUDE.md')));
}

function expectedAgentsMd(dir) {
  return AGENTS_HEADER + fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
}

export function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Minimal TOML serializer for the flat { name: { command, args, env } } shape used by
 *  .mcp.json — no TOML library needed given how simple that shape is. */
export function mcpServersToToml(mcpServers) {
  const lines = ['# Generated from .mcp.json by `npm run sync:agent-configs` — edit .mcp.json, not this file.', ''];
  for (const [name, def] of Object.entries(mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlString(def.command)}`);
    if (def.args) lines.push(`args = [${def.args.map(tomlString).join(', ')}]`);
    lines.push('');
    if (def.env && Object.keys(def.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, v] of Object.entries(def.env)) lines.push(`${k} = ${tomlString(v)}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function expectedCursorMcpJson(mcpServers) {
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

function main() {
  const { mcpServers } = JSON.parse(fs.readFileSync(path.join(repoRoot, '.mcp.json'), 'utf8'));

  const targets = agentsMdTargetDirs().map((dir) => ({
    file: path.join(dir, 'AGENTS.md'),
    content: expectedAgentsMd(dir),
  }));
  targets.push({ file: path.join(repoRoot, '.cursor/mcp.json'), content: expectedCursorMcpJson(mcpServers) });
  targets.push({ file: path.join(repoRoot, '.codex/config.toml'), content: mcpServersToToml(mcpServers) });

  const stale = targets.filter(
    ({ file, content }) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content,
  );

  if (check) {
    if (stale.length === 0) {
      console.log('agent configs up to date.');
      return;
    }
    console.error('Stale/missing generated agent config files (run `npm run sync:agent-configs`):');
    for (const { file } of stale) console.error(`  - ${path.relative(repoRoot, file)}`);
    process.exitCode = 1;
    return;
  }

  for (const { file, content } of stale) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
  if (stale.length === 0) console.log('agent configs already up to date.');
}

// Only run when invoked directly (`node sync-agent-configs.mjs`), not when imported —
// e.g. by engine/tests/assets/agentConfigSerialization.test.ts, which imports the pure
// serializer functions above and must not trigger a real read/write of repo files.
// pathToFileURL (not a naive `file://${...}` template) — required for this comparison to
// hold on Windows, where argv[1] is a backslashed/drive-lettered path that Node's own
// import.meta.url reformats (forward slashes, `file:///C:/...`); string-concatenating it
// would never match, silently turning `npm run sync:agent-configs` into a no-op there.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
