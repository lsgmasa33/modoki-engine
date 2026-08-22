/** Test harness: load the REAL `modoki_*` tool surface and call real handlers.
 *
 *  This is what the E1 split (`engine/tools/modoki-mcp/src/registerAll.ts`) bought. Before it,
 *  `index.ts` called `main()` at import, so no test could load the tool surface at all — guard
 *  tests scanned source as TEXT, and `modoki_prefab` 400'd on EVERY call for months with a green
 *  suite. Now a test builds a context against a STUB backend, registers every tool, and invokes
 *  handlers by name, asserting on the HTTP request each one actually made.
 *
 *  Not a mock of the tools — the tools are real. Only the backend is stubbed.
 */

import { vi } from 'vitest';
import { z } from '../../tools/modoki-mcp/node_modules/zod';
import { createToolContext } from '../../tools/modoki-mcp/src/context';
import { registerAllTools } from '../../tools/modoki-mcp/src/registerAll';
import { clearRegistry, getTool, toolNames } from '../../tools/modoki-mcp/src/registry';
import type { ToolResult } from '../../tools/modoki-mcp/src/result';

export type StubRequest = {
  method: string;
  /** Path + query only — the stub backend origin is stripped, since it is an implementation detail. */
  path: string;
  /** Parsed JSON body, or undefined for a GET. */
  body: unknown;
  headers: Record<string, string>;
};

export type StubReply = { status?: number; body?: unknown };

/** Reply to a stubbed request. Return `undefined` to get the default `200 {ok:true}`. */
export type Responder = (req: StubRequest) => StubReply | undefined;

export const STUB_BACKEND = 'http://stub.modoki.test';

export type Surface = {
  /** Every request the tools made, in order. */
  requests: StubRequest[];
  /** Call a tool by name, VALIDATING `args` through that tool's own zod shape first — exactly
   *  what the MCP transport and `modoki_batch` do. Throws if the tool does not exist (a missing
   *  tool is the bug this harness exists to catch, not a skip) or if the args are invalid.
   *
   *  Validating is not pedantry, it is FIDELITY. An unvalidated harness reaches states the real
   *  surface cannot: calling every tool with `{}` made six of them interpolate a missing required
   *  param into the URL (`/api/validate-scene?path=undefined`) and made `modoki_resolve_refs`
   *  throw a raw TypeError — all unreachable in practice, because zod rejects the call first.
   *  An audit harness that manufactures impossible states manufactures false findings. */
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  /** Invoke the handler WITHOUT zod validation. Only for deliberately testing what a handler
   *  does with malformed input — never as the default path. */
  callRaw: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  /** Parse a tool result's text payload as JSON. */
  json: (r: ToolResult) => unknown;
  text: (r: ToolResult) => string;
  names: string[];
  /** The last request, for the common single-call assertion. */
  last: () => StubRequest | undefined;
  /** The inputSchema each tool was actually registered with — so a test can assert the surface
   *  reaches validation STRICT rather than trusting that it does. */
  schemaFor: (name: string) => unknown;
  /** The registered description — what the model actually reads before calling. */
  descriptionOf: (name: string) => string;
  restore: () => void;
};

/** Register the whole surface against a stub backend.
 *
 *  Call `restore()` in `afterEach` — this stubs global `fetch` and populates the module-level
 *  registry, both of which leak between tests otherwise. */
export function loadSurface(responder?: Responder): Surface {
  clearRegistry();
  const requests: StubRequest[] = [];
  /** name → the inputSchema the tool was registered with (see the fake server below). */
  const registeredSchemas = new Map<string, unknown>();

  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const req: StubRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.startsWith(STUB_BACKEND) ? url.slice(STUB_BACKEND.length) : url,
      body: typeof init?.body === 'string' ? safeParse(init.body) : undefined,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    };
    requests.push(req);
    const reply = responder?.(req) ?? defaultReply(req) ?? {};
    const status = reply.status ?? 200;
    const body = 'body' in reply ? reply.body : { ok: true };
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchStub);

  const ctx = createToolContext({ backend: STUB_BACKEND });
  // A fake server. Using the real McpServer would drag the MCP SDK into every test for no
  // assertion value — but it must implement whatever the definer actually calls, and it records
  // the schema each tool was registered WITH so a test can assert the surface is strict
  // (`docs/mcp-tool-conventions.md` §1).
  const server = {
    registerTool: vi.fn((name: string, config: { inputSchema?: unknown }) => {
      registeredSchemas.set(name, config?.inputSchema);
    }),
    tool: vi.fn(() => {
      throw new Error(
        'registered via the legacy server.tool() overload — conventions §1: the schema must reach ' +
        'validation as a STRICT ZodObject, and tool() rejects one ("expected a Zod schema or ' +
        'ToolAnnotations"). Use server.registerTool(name, {description, inputSchema}, cb).',
      );
    }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, ctx);

  const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');
  const need = (name: string) => {
    const entry = getTool(name);
    if (!entry) throw new Error(`tool '${name}' is not registered — registered: ${toolNames().join(', ')}`);
    return entry;
  };
  return {
    requests,
    names: toolNames(),
    text,
    json: (r) => JSON.parse(text(r)),
    last: () => requests[requests.length - 1],
    schemaFor: (name) => registeredSchemas.get(name),
    descriptionOf: (name) => need(name).description,
    call: async (name, args = {}) => {
      const entry = need(name);
      // Parse against the schema the tool was REGISTERED with, not a rebuilt one.
      //
      // This used to be `z.object(entry.shape).strict()` — same shape, same strictness, and a
      // DIFFERENT schema: `registerAll.ts` passes `.strict(<message naming the tool's real
      // params>)`, which is the entire §5 payload of §1 ("a refusal that lists the options is what
      // turns a dead end into the caller's next move"). Rebuilding it dropped that message, so
      // every test that provoked an unknown key saw zod's default `Unrecognized key(s) in object`
      // and the parameter list was asserted NOWHERE — on the one surface where the SDK does deliver
      // it (verified: zod sets it on the `unrecognized_keys` issue, `normalizeObjectSchema` passes
      // a v3 ZodObject through untouched, and `getParseErrorMessage` returns `i.message` verbatim
      // for a path-less issue).
      //
      // It was also a fidelity bug in exactly the way this file's own header warns about: a harness
      // that validates with a schema the surface does not use reaches states the surface cannot.
      // The device harness never had it — `parseDeviceArgs` and its transport share one
      // `strictSchema()` — which is the shape to copy.
      const registered = registeredSchemas.get(name) as z.ZodType | undefined;
      const schema = registered ?? z.object(entry.shape).strict();
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`invalid args for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      }
      return entry.handler(parsed.data);
    },
    callRaw: async (name, args = {}) => need(name).handler(args),
    restore: () => {
      vi.unstubAllGlobals();
      clearRegistry();
    },
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** Plausible bodies for the routes tools PROBE on their way somewhere else.
 *
 *  Without this, a bare `{ok:true}` for `/api/editor-state` means `activeScenePath` cannot resolve
 *  the active scene, so `mutate_scene` and `set_transform` correctly refuse — and never reach
 *  `/api/scene-mutate` at all. A test asserting on their real route would then "discover" that
 *  they don't call it, which is a fact about the stub, not about the tool.
 *
 *  `scenePathRef` (not `scenePath`) on purpose: `scenePath` is Vite's `/@fs/<abs>` URL, which
 *  `/api/scene-mutate` 403s — the bug that made `set_transform`'s documented `path` default fail
 *  on every call. The stub must model the field the code is required to read. */
function defaultReply(req: StubRequest): StubReply | undefined {
  if (req.path.split('?')[0] === '/api/editor-state') {
    return { body: { ok: true, scenePath: '/@fs/tmp/stub/main.json', scenePathRef: '/assets/scenes/main.json', unsavedChanges: false, entityCount: 0 } };
  }
  return undefined;
}

/** Requests excluding the once-per-context `/api/identity` probe, which every tool triggers
 *  and no test is asserting about. */
export function realRequests(s: Surface): StubRequest[] {
  return s.requests.filter((r) => r.path !== '/api/identity');
}
