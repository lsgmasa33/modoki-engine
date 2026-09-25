/** Test harness: load the REAL `device_*` tool surface and call real handlers.
 *
 *  The device twin of `mcpSurface.ts`, and it closes the gap that file's header describes from the
 *  other side. Until now the device server registered its tools straight onto `server.tool` inside
 *  a function needing a live MCP server, so NO test could call a handler and assert on the request
 *  it made. Device coverage was unit tests on helpers plus source guards — which prove a call
 *  SHAPE and nothing about behaviour, and a source guard cannot notice a tool that stops working.
 *
 *  Not a mock of the tools — the tools are real. Only the backend is stubbed.
 *
 *  NOTE the module-level `BACKEND` in `mcp-tools.ts` is read at IMPORT time from the environment,
 *  so this sets it before the dynamic import and the value is fixed for the process. That is why
 *  `loadDeviceSurface` is async and why the stub URL is a constant rather than a parameter.
 */

import { vi } from 'vitest';

export const DEVICE_STUB_BACKEND = 'http://device-stub.modoki.test';

export type StubRequest = { method: string; path: string; body: unknown };
/** `raw` sends a body verbatim instead of JSON — an editor without a route answers its HTML page. */
export type StubReply = { status?: number; body?: unknown; raw?: string };
export type Responder = (req: StubRequest) => StubReply | undefined;

export type DeviceSurface = {
  requests: StubRequest[];
  names: string[];
  /** Call a tool by name, VALIDATING args through its real (strict) shape first — exactly what
   *  the MCP transport does. Throws on invalid args, which is what the transport surfaces. */
  call: (name: string, args?: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  /** The strict-validation verdict alone, for asserting on refusals without invoking anything. */
  validate: (name: string, args?: Record<string, unknown>) => { ok: boolean; error?: string };
  text: (r: { content: Array<{ type: string; text?: string }> }) => string;
  /** The registered description — what the model actually reads before choosing the tool. The
   *  editor harness has had this since the audit; the device surface needs it for the same reason,
   *  since a description is the only thing standing between an agent and a wrong tool. */
  descriptionOf: (name: string) => string;
  /** The registered zod shape, so a test can read a PARAMETER's advertised description — the
   *  editor twin gets this from `schemaFor` + zodToJsonSchema. Needed for the vocabularies that
   *  cannot be a `z.enum` (#1094's `key`), where parity lives in the description rather than in a
   *  list of members, and the device half would otherwise be pinned by nothing. */
  shapeFor: (name: string) => Record<string, { description?: string }>;
  /** Requests excluding the once-per-process `/api/identity` probe. */
  real: () => StubRequest[];
  last: () => StubRequest | undefined;
  restore: () => void;
};

/** The `/api/device/request` envelope the lease relay returns: `{result}`, where the device
 *  `safeStringify`s its own reply. Tests describe the DEVICE's answer and this wraps it. */
export function deviceReply(result: unknown): StubReply {
  return { body: { result: typeof result === 'string' ? result : JSON.stringify(result) } };
}

export async function loadDeviceSurface(responder?: Responder): Promise<DeviceSurface> {
  process.env.MODOKI_BACKEND = DEVICE_STUB_BACKEND;
  const requests: StubRequest[] = [];

  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const req: StubRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.startsWith(DEVICE_STUB_BACKEND) ? url.slice(DEVICE_STUB_BACKEND.length) : url,
      body: typeof init?.body === 'string' ? safeParse(init.body) : undefined,
    };
    requests.push(req);
    const reply = responder?.(req) ?? defaultReply(req) ?? {};
    const status = reply.status ?? 200;
    const body = 'body' in reply ? reply.body : { ok: true };
    return new Response(reply.raw ?? (body === undefined ? '' : JSON.stringify(body)), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchStub);

  // FRESH MODULE per surface. `mcp-tools.ts` memoizes the identity probe and its banner in
  // module-level state (`identityWarning`, `_identityProbe`), so without this a test that armed a
  // wrong-clone warning leaked it into every later test in the file — and the "no false alarm"
  // case was asserting against a banner the PREVIOUS test had set. `clearDeviceRegistry()` only
  // clears the tool map; it cannot reach that state.
  vi.resetModules();
  const { registerTools } = await import('../../tools/game-debug-mcp/src/mcp-tools');
  const { getDeviceTool, deviceToolNames, clearDeviceRegistry, parseDeviceArgs } =
    await import('../../tools/game-debug-mcp/src/registry');
  clearDeviceRegistry();

  // The schema each tool was registered WITH, so `validate`/`call` can go through the SDK's
  // validation seam exactly as the wire does — `installArgCoercion` wraps it (#1560), and a harness
  // that skipped it could not tell whether `registerTools` still installs the decoding.
  const registeredSchemas = new Map<string, unknown>();
  const server = {
    // SYNCHRONOUS on purpose (the SDK's is async): the wrapper returns whatever this returns, and a
    // sync harness keeps `validate` callable without an await at its ~40 call sites.
    validateToolInput: (_tool: unknown, args: unknown) => args,
    registerTool: vi.fn((name: string, config: { inputSchema?: unknown }) => { registeredSchemas.set(name, config?.inputSchema); }),
    tool: vi.fn(() => { throw new Error('device tools must register through createDeviceToolDef (registry.ts), not server.tool'); }),
  } as unknown as Parameters<typeof registerTools>[0];
  registerTools(server);

  const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');
  const decode = (name: string, args: unknown) => (server as unknown as { validateToolInput: (t: unknown, a: unknown, n: string) => unknown })
    .validateToolInput({ inputSchema: registeredSchemas.get(name) }, args, name);
  return {
    requests,
    names: deviceToolNames(),
    descriptionOf: (name: string) => {
      const entry = getDeviceTool(name);
      if (!entry) throw new Error(`device tool '${name}' is not registered — have: ${deviceToolNames().join(', ')}`);
      return entry.description;
    },
    shapeFor: (name: string) => {
      const entry = getDeviceTool(name);
      if (!entry) throw new Error(`device tool '${name}' is not registered — have: ${deviceToolNames().join(', ')}`);
      return entry.shape as unknown as Record<string, { description?: string }>;
    },
    text,
    real: () => requests.filter((r) => r.path !== '/api/identity'),
    last: () => requests[requests.length - 1],
    validate: (name, args = {}) => {
      const r = parseDeviceArgs(name, decode(name, args));
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    call: async (name, args = {}) => {
      const entry = getDeviceTool(name);
      if (!entry) throw new Error(`device tool '${name}' is not registered — have: ${deviceToolNames().join(', ')}`);
      const parsed = parseDeviceArgs(name, decode(name, args));
      if (!parsed.ok) throw new Error(`invalid args for ${name}: ${parsed.error}`);
      return (entry.handler as (a: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>)(parsed.data);
    },
    restore: () => { vi.unstubAllGlobals(); clearDeviceRegistry(); },
  };
}

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

/** Plausible answers for the routes tools probe on their way somewhere else — a connected lease
 *  and a matching identity, so a test asserting on a tool's OWN behaviour is not really asserting
 *  on the stub's silence. */
function defaultReply(req: StubRequest): StubReply | undefined {
  if (req.path === '/api/identity') {
    return { body: { repoRoot: process.cwd(), projectRoot: `${process.cwd()}/games/x`, backendPort: 5181, pid: 1, branch: 'test', packaged: false } };
  }
  if (req.path === '/api/device/status') {
    return { body: { state: 'connected', target: { host: '10.0.0.5', port: 8095, useAdb: false }, lastTarget: null } };
  }
  return undefined;
}
