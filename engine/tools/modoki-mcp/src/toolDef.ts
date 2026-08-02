/** The one way a tool gets defined.
 *
 *  A group module receives this function rather than the `McpServer`, so a group physically
 *  CANNOT call `server.tool()` directly — which was previously only prevented by a source guard
 *  scanning for the string `server.tool(`. A bare registration is invisible to `modoki_batch`
 *  (which resolves steps by name through `registry.ts`), i.e. the tool exists but the batch
 *  claims it doesn't. Making it unreachable beats detecting it.
 *
 *  Side-effect-free: types only.
 */

import type { z, ZodRawShape } from 'zod';
import type { ToolResult } from './result.js';

export type ToolDef = <S extends ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>,
) => void;

/** Every group module's shape: given a definer and a context, register its tools. */
export type ToolGroup = (tool: ToolDef, ctx: import('./context.js').ToolContext) => void;
