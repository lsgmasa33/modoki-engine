/** Register every `modoki_*` tool onto an MCP server — the whole surface, in one call.
 *
 *  This is the module TESTS import. It is side-effect-free: importing it registers nothing,
 *  so a test can build a `ToolContext` pointed at a stub backend, register onto a throwaway
 *  server, and then call real handlers by name through `registry.ts`.
 *
 *  Why that matters more than tidiness: before this split, the tool surface lived in an
 *  `index.ts` that called `main()` at import, so vitest could not load it at all. Guard tests
 *  scanned source as TEXT, and `modoki_prefab` 400'd on EVERY call for months with a green
 *  suite. An importable surface is the precondition for testing it.
 *
 *  Group order is the order tools appear over MCP (`registry.ts` is insertion-ordered), and it
 *  matches the old single-file order so the advertised surface is byte-identical.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './registry.js';
import type { ToolContext } from './context.js';
import type { ToolDef } from './toolDef.js';
import { errorDetailOf, retargetNarrowHint, type ToolResult } from './result.js';
import { contractFor } from './contracts.js';
import { registerBatchTool } from './tools/batch.js';
import { registerSceneTools } from './tools/scene.js';
import { registerRenderTools } from './tools/render.js';
import { registerInputTools } from './tools/input.js';
import { registerEditorTools } from './tools/editor.js';
import { registerProjectTools } from './tools/project.js';
import { registerRuntimeTools } from './tools/runtime.js';
import { registerAssetTools } from './tools/assets.js';

/** The registration groups, in surface order. Exported so a test can assert the surface is
 *  fully covered rather than trusting that a new group was wired in here. */
export const TOOL_GROUPS = [
  registerBatchTool,
  registerSceneTools,
  registerRenderTools,
  registerInputTools,
  registerEditorTools,
  registerProjectTools,
  registerRuntimeTools,
  registerAssetTools,
] as const;

/** Build the definer that puts a tool on BOTH the MCP transport and the callable registry.
 *
 *  EVERY tool goes through here. The MCP transport and `registry.ts` can never disagree about
 *  what exists, because one call does both — see `toolDef.ts` for why a group cannot bypass it.
 *  See `docs/debug-tools-mcp.md` (`modoki_batch`). */
export function createToolDef(server: McpServer, ctx: ToolContext): ToolDef {
  return (name, description, shape, handler) => {
    // §5 requires every envelope to name the tool that refused. Rather than repeat the name at
    // ~40 call sites (where it WILL drift after a rename), a failing result carries its detail on
    // the `ERROR_DETAIL` symbol and gets the name stamped in here — the one place that knows it.
    //
    // A symbol, not a mutable "current tool" slot: MCP calls interleave, so any module-level
    // current-tool would attribute one tool's refusal to another under concurrency. And not
    // text-parsing either: the rendered text may carry an identity-warning banner in front of the
    // JSON, so there is nothing reliable to parse.
    // S3.21 — the over-cap hint names THIS tool's filters. The generic fallback list was
    // `get_scene_state`'s (trait=/where=/layer=…), advertised to every capped read, so a capped
    // `get_console_logs` was told to narrow with parameters its own strict schema refuses. The
    // contract table already knows each tool's real filters; intersect with the schema so a stale
    // declaration can never advertise a param the tool does not have.
    const declared = contractFor(name)?.filters ?? [];
    const filters = declared.filter((f) => f in shape);
    const stamped = async (args: unknown) => {
      const result = await handler(args as never);
      const detail = errorDetailOf(result as ToolResult);
      if (detail) return detail.tool ? result : ctx.fail({ ...detail, tool: name });
      if (!filters.length) return result;
      const r = result as ToolResult;
      return {
        ...r,
        content: r.content.map((c) => (c.type === 'text' ? { ...c, text: retargetNarrowHint(c.text, filters) } : c)),
      };
    };
    // STRICT, and it has to happen HERE — see `docs/mcp-tool-conventions.md` §1.
    //
    // zod strips unknown keys by default, and the SDK builds a plain `z.object(shape)` from a raw
    // shape (`zod-compat.js` objectFromShape). For a tool whose params are all optional that turns
    // a TYPO INTO A DIFFERENT OPERATION: `modoki_set_selection {name:'Capsule'}` — there is no
    // `name` param — parsed to `{}`, which that tool documents as "no refs = clear", so it CLEARED
    // the human's selection and reported ok. That was measured. The fix shipped for
    // `modoki_batch`'s pre-flight only, leaving every DIRECT call — where most calls happen —
    // still silently dropping the key.
    //
    // Wrapping the handler cannot fix it: the SDK validates first and invokes the callback with
    // `parseResult.data`, so the unknown key is already gone by then. The schema itself must
    // refuse, which is why a strict ZodObject (not the raw shape) goes to `server.tool`. The SDK
    // passes an object schema straight through to validation, and the advertised JSON Schema gains
    // `additionalProperties: false` — so the strictness is visible to the client too.
    //
    // The message names the tool's REAL parameters, because a refusal that lists the options is
    // what turns a dead end into the caller's next move (§5).
    const params = Object.keys(shape);
    const strict = z.object(shape).strict(
      `${name} received an unrecognized parameter. It accepts: ${params.length ? params.join(', ') : '(no parameters)'}.`,
    );
    // `server.registerTool(name, config, cb)`, NOT `server.tool(...)`: the older `tool()` overload
    // guesses which argument is the schema by shape-sniffing, and it rejects a ZodObject outright
    // ("expected a Zod schema or ToolAnnotations, but received an unrecognized object" — measured).
    // The config form passes `inputSchema` straight through to validation.
    server.registerTool(name, { description, inputSchema: strict as never }, stamped as never);
    // The registry keeps the RAW shape: `modoki_batch` builds its own `z.object(shape).strict()`
    // per step, and a pre-built schema would deny it that. The STAMPED handler goes in too, so a
    // refusal reported inside a `modoki_batch` step names the step's tool, not nothing.
    registerTool({ name, description, shape, handler: stamped as (args: unknown) => Promise<ToolResultLike> });
  };
}

type ToolResultLike = Awaited<ReturnType<Parameters<ToolDef>[3]>>;

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  const tool = createToolDef(server, ctx);
  for (const register of TOOL_GROUPS) register(tool, ctx);
}
