/**
 * Device MCP — a thin client of Modoki's device lease.
 *
 * It owns NO connection: every `device_*` tool proxies through the editor backend at
 * $MODOKI_BACKEND (`/api/device/*`), which holds the deliberate, human-initiated lease to the
 * physical device. No Bonjour, no adb, no discovery here. See
 * docs/debug-tools-mcp.md.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './mcp-tools.js';

async function main() {
  const server = new McpServer({ name: 'modoki-device', version: '2.0.0' });
  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const backend = process.env.MODOKI_BACKEND ?? 'http://127.0.0.1:5179';
  process.stderr.write(`[device-mcp] MCP server started (backend: ${backend})\n`);
}

main().catch((err) => {
  process.stderr.write(`[device-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
