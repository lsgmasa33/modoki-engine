/**
 * Modoki MCP server — the Claude-friendly authoring surface. A thin, transport-agnostic
 * wrapper over the editor backend HTTP API (the Phase-1 router, served by either the Vite dev
 * server or the Electron main process). The user's own Claude Code connects to this over stdio
 * and edits the project's scenes/assets through validated tools, then verifies its own work.
 *
 * Backend base: MODOKI_BACKEND env (e.g. http://127.0.0.1:<port> for the Electron editor) —
 * defaults to the Vite dev server at http://localhost:5173.
 *
 * THIS FILE IS THE EXECUTABLE ENTRY, and deliberately nothing else. It is the ONE module that
 * reads the environment and starts a transport; everything testable lives beside it:
 *
 *   context.ts      transport + formatting, as a factory over an injected backend
 *   shapes.ts       zod shapes shared by more than one tool
 *   toolDef.ts      the only way to define a tool
 *   registerAll.ts  registers the whole surface onto a server  ← what tests import
 *   tools/*.ts      the tool definitions, by group, side-effect-free
 *
 * Do not move tool definitions back in here. The path `engine/tools/modoki-mcp/src/index.ts` is
 * pinned by `.mcp.json`, `.cursor/mcp.json`, the Electron Connect-Claude writer, the esbuild
 * bundle step and the packaging manifest test — so the entry stays put while the surface stays
 * importable. See `registerAll.ts` for why that split is load-bearing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createToolContext } from './context.js';
import { registerAllTools } from './registerAll.js';

const BACKEND = (process.env.MODOKI_BACKEND || 'http://localhost:5173').replace(/\/$/, '');

const server = new McpServer({ name: 'modoki', version: '1.0.0' });
registerAllTools(server, createToolContext({ backend: BACKEND, token: process.env.MODOKI_TOKEN }));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[modoki-mcp] started — backend ${BACKEND}\n`);
}

main().catch((e) => {
  process.stderr.write(`[modoki-mcp] fatal: ${e}\n`);
  process.exit(1);
});
