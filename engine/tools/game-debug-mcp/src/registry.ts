/** The device server's tool DEFINER + callable registry — the twin of the editor server's
 *  `registerAll.ts` + `registry.ts`.
 *
 *  Two problems this solves, and they are the same two the editor server had:
 *
 *  1. **Nothing validated unknown argument keys.** Tools were registered with a bare zod shape,
 *     and zod STRIPS keys it does not declare — so a misspelled param became a DIFFERENT
 *     operation that reported success. Measured shape: `device_watch {action:'clear', ids:'w3'}`
 *     drops `ids` (the param is `id`), and the tool's own contract says "omit on clear to clear
 *     ALL" — so a typo cleared every watch. The editor server fixed this at its single definition
 *     point (`docs/mcp-tool-conventions.md` §1); this is that point for the device server.
 *
 *  2. **The surface was not importable.** Tools registered straight onto `server.tool` inside a
 *     function that needed a live MCP server, so no test could call a handler and assert on the
 *     request it made. Device coverage was therefore unit tests on helpers plus source guards —
 *     which prove a call SHAPE and nothing about behaviour. That gap was named in the audit; this
 *     closes it.
 */

import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type DeviceToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

export type RegisteredDeviceTool = {
  name: string;
  description: string;
  shape: ZodRawShape;
  handler: (args: never) => Promise<DeviceToolResult> | DeviceToolResult;
};

/** Validate `args` against a tool's real shape, STRICTLY — what the MCP transport does before
 *  invoking the handler. Exported so a test drives the same path a real call does rather than
 *  reaching past validation (an unvalidated harness reaches states the surface cannot, and then
 *  manufactures findings about them). */
export function parseDeviceArgs(name: string, args: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  const entry = registry.get(name);
  if (!entry) return { ok: false, error: `tool '${name}' is not registered` };
  const r = strictSchema(name, entry.shape).safeParse(args ?? {});
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.issues.map((i) => i.message).join('; ') };
}

/** zod 4 here (the editor server pins zod 3) — `.strict()` takes NO message, so the accepted-param
 *  list goes through `strictObject`'s `error` option. Same contract, different dialect. */
function strictSchema(name: string, shape: ZodRawShape) {
  const params = Object.keys(shape);
  return z.strictObject(shape, {
    error: `${name} received an unrecognized parameter. It accepts: ${params.length ? params.join(', ') : '(no parameters)'}.`,
  });
}

const registry = new Map<string, RegisteredDeviceTool>();

export function getDeviceTool(name: string): RegisteredDeviceTool | undefined { return registry.get(name); }
export function deviceToolNames(): string[] { return [...registry.keys()]; }
export function clearDeviceRegistry(): void { registry.clear(); }

/** Define a device tool: strict schema on the wire AND an entry a test can call. */
export type DeviceToolDef = <S extends ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<DeviceToolResult> | DeviceToolResult,
) => void;

export function createDeviceToolDef(server: McpServer): DeviceToolDef {
  return ((name: string, description: string, shape: ZodRawShape, handler: (args: never) => Promise<DeviceToolResult> | DeviceToolResult) => {
    // STRICT — see the header. The message names the tool's REAL parameters, because a refusal
    // that lists the options is what turns a dead end into the caller's next move (§5).
    server.registerTool(name, { description, inputSchema: strictSchema(name, shape) as never }, handler as never);
    registry.set(name, { name, description, shape, handler });
  }) as DeviceToolDef;
}
