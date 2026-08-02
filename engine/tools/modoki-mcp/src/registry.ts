/** The callable tool registry — every `modoki_*` tool, addressable BY NAME at runtime.
 *
 *  Why this exists: `McpServer.tool()` registers a tool with the MCP transport and then
 *  forgets it. Nothing can later look a tool up by name and call it. That is fine for the
 *  one-call-per-turn surface the server was built for, and insufficient for `modoki_batch`
 *  (`docs/debug-tools-mcp.md`), which must resolve a step's `tool` string to a real
 *  handler AND validate its `args` against that tool's REAL zod schema.
 *
 *  That last part is the load-bearing bit. A batch envelope has to type its steps as
 *  `args: z.record(z.any())` — there is no way to express "72 different shapes depending on a
 *  sibling field" in one schema. Without this registry the batch would therefore forfeit all 72
 *  hand-written schemas at exactly the moment the model is authoring ten argument objects with
 *  no per-call feedback. With it, the executor re-parses each step against `z.object(shape)`
 *  server-side and validation is preserved.
 *
 *  WHY A SEPARATE MODULE, and not a `Map` inside index.ts: `index.ts` calls `main()` at module
 *  load, so vitest cannot import it — see the header of
 *  `engine/tests/tools/mcpFormatterGuard.test.ts`, which is reduced to scanning the source as
 *  TEXT for exactly this reason. Anything that needs real unit tests has to live outside
 *  `index.ts`. Keep it that way: this module must stay free of side effects.
 */

import type { ZodRawShape } from 'zod';
import type { ToolResult } from './result.js';

/** A registered tool's callable form. `args` is the already-zod-parsed object — the registry
 *  stores the raw shape so a caller (the batch executor) can do that parse itself. */
export type ToolHandler = (args: any) => Promise<ToolResult>;

export type RegisteredTool = {
  name: string;
  description: string;
  /** The tool's zod raw shape, exactly as handed to `McpServer.tool()`. Wrap in `z.object()`
   *  to validate a candidate `args` object. */
  shape: ZodRawShape;
  handler: ToolHandler;
};

/** Insertion-ordered, name-keyed. Populated at import time by `index.ts`. */
const registry = new Map<string, RegisteredTool>();

/** Record a tool. Called by index.ts's `tool()` wrapper alongside `server.tool()`, so the
 *  registry and the MCP transport can never disagree about what exists.
 *
 *  Throws on a duplicate name: two tools sharing a name means one silently shadows the other
 *  in here while BOTH appear over MCP — a divergence that would make the batch call a
 *  different tool than the one the model named. Loud is correct. */
export function registerTool(entry: RegisteredTool): void {
  if (registry.has(entry.name)) {
    throw new Error(`modoki-mcp: duplicate tool name '${entry.name}' — names must be unique.`);
  }
  registry.set(entry.name, entry);
}

export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

export function toolNames(): string[] {
  return [...registry.keys()];
}

export function toolCount(): number {
  return registry.size;
}

/** Test-only. The registry is module-level state and `index.ts` populates it as a side effect
 *  of import; a test that builds its own fake registry needs a way back to empty. */
export function clearRegistry(): void {
  registry.clear();
}
