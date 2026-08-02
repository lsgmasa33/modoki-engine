/** Type sidecar for `sync-agent-configs.mjs` — see that file for the design
 *  rationale. Hand-written because the module is plain JS (a Node CLI + generated-file
 *  serializers imported directly by `engine/tests/assets/agentConfigSerialization.test.ts`),
 *  following the sibling `.d.mts` convention established by `engine/scripts/ota/schema.d.mts`.
 *  Only the pure serializer exports are declared — `main()` runs on direct invocation only
 *  and is never imported. */

/** One server entry from `.mcp.json`'s `mcpServers` map. */
export interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Quotes and escapes a TOML string value (backslashes first, then quotes, so the
 *  quote-escaping doesn't re-touch the backslashes it just added). */
export function tomlString(s: string): string;

/** Minimal TOML serializer for the flat `{ name: McpServerDef }` shape used by
 *  `.mcp.json`, producing Codex CLI's `[mcp_servers.<name>]` table format. */
export function mcpServersToToml(mcpServers: Record<string, McpServerDef>): string;

/** Wraps `mcpServers` under a `mcpServers` key for Cursor's `.cursor/mcp.json`,
 *  ending in a single trailing newline for stable diffs. */
export function expectedCursorMcpJson(mcpServers: Record<string, McpServerDef>): string;
