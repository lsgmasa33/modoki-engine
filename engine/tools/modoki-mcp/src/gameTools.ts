/** The DYNAMIC tail of the tool surface — tools a GAME registers (#270).
 *
 *  The `modoki_*` surface is fixed: eight groups, registered once at startup, alive for the life
 *  of the process. This is the other kind. A game declares tools with `registerAgentTool` from
 *  `@modoki/engine/runtime`; they arrive here over `/api/game-tools` and become real MCP tools —
 *  real schema, real refusal envelope, addressable from `modoki_batch` — beside the engine's.
 *
 *  WHY A POLL, and not a fetch at startup. This process is spawned with the Claude SESSION; the
 *  editor is launched later, by hand or by an agent, and swapped between projects while the
 *  session runs. A startup-only fetch would therefore find no editor and no game tools in very
 *  nearly every session — the tools would be permanently invisible, which is the exact failure
 *  the seam exists to remove. Polling is what lets `court_load_level` appear a few seconds after
 *  the editor opens and disappear when it closes. The MCP spec's `tools/list_changed`
 *  notification is what makes that legible to the client; the SDK sends it for us on
 *  register/remove.
 *
 *  The poll is deliberately dumb and cheap: one localhost GET, comparing a `version` the game
 *  registry bumps. It backs off hard while nothing is listening, so a session with no editor
 *  open (the common case) costs a request every 30s rather than every 5.
 */

import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { defineTool } from './registerAll.js';
import { unregisterTool } from './registry.js';
import type { ToolResult } from './result.js';

/** One param, exactly as `AgentToolParam` in the engine's registry serializes it. */
type ParamDecl =
  | { type: 'string'; description: string; required?: boolean; enum?: string[] }
  | { type: 'number'; description: string; required?: boolean; int?: boolean }
  | { type: 'boolean'; description: string; required?: boolean };

type ToolDecl = {
  name: string;
  description: string;
  params?: Record<string, ParamDecl>;
  mutates: boolean;
};

/** Poll cadence. Fast enough that a tool appears within a few seconds of the editor opening;
 *  slow enough that an all-day session with no editor is background noise. */
const POLL_OK_MS = 5_000;
const POLL_DOWN_MS = 30_000;

/** Rebuild a zod shape from the JSON declaration.
 *
 *  Returns null — refusing the WHOLE tool — on any param type it does not recognise, rather than
 *  falling back to `z.any()` for the odd one out. A silently-untyped param is precisely how a
 *  typo becomes a different operation (the `set_selection {name:…}` incident that made the whole
 *  surface strict, see `registerAll.ts`), and a game tool must not be the one place that
 *  reintroduces it. A refused tool is reported, not dropped quietly. */
export function shapeFromDecl(params: Record<string, ParamDecl> | undefined): ZodRawShape | null {
  const shape: ZodRawShape = {};
  for (const [key, p] of Object.entries(params ?? {})) {
    let base;
    if (p.type === 'string') {
      base = p.enum && p.enum.length ? z.enum(p.enum as [string, ...string[]]) : z.string();
    } else if (p.type === 'number') {
      base = p.int ? z.number().int() : z.number();
    } else if (p.type === 'boolean') {
      base = z.boolean();
    } else {
      return null;
    }
    const described = base.describe(String((p as { description?: string }).description ?? ''));
    shape[key] = p.required ? described : described.optional();
  }
  return shape;
}

/** A stable fingerprint of the declared surface.
 *
 *  `version` alone is NOT enough and that is worth being explicit about: it is per-RENDERER
 *  state, so it resets to 0 whenever the page reloads — which a game `.ts` edit does on every
 *  save. A version that went 4 → 0 while the tools genuinely changed would read as "no change"
 *  and leave a stale surface registered. Hashing the declarations themselves makes the
 *  comparison independent of that, and catches an in-place schema edit too. */
export function fingerprint(tools: ToolDecl[]): string {
  return JSON.stringify(
    tools
      .map((t) => [t.name, t.description, t.mutates, t.params ?? {}])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

export type GameToolSync = {
  /** Fetch once and reconcile. Exposed for tests and for the startup call.
   *
   *  `reachable` reports whether the BACKEND answered — not whether it had any tools. The poll
   *  paces itself on that distinction: an editor open on a project that registers none is still
   *  a live editor worth watching at the fast cadence, because the human may open Court next. */
  refresh: () => Promise<{ reachable: boolean; registered: string[]; refused: Record<string, string> }>;
  start: () => void;
  stop: () => void;
  /** Currently-registered game tool names. */
  active: () => string[];
};

export function createGameToolSync(server: McpServer, ctx: ToolContext): GameToolSync {
  /** name → the SDK handle that can take it back off the transport. */
  const registered = new Map<string, { remove: () => void }>();
  let lastPrint = '';
  /** Why the tools that are NOT registered are missing. Kept across polls: a caller asking "where
   *  is my tool?" polls `refresh()`, and answering only on the poll that happened to discover the
   *  problem makes every later answer an empty — and wrong — all-clear. */
  let lastRefused: Record<string, string> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /** Tear the whole tail down.
   *
   *  Clears `lastPrint` too, and that is not tidiness: the fingerprint means "this is what
   *  `registered` currently reflects", so leaving it set after removing everything makes the next
   *  refresh short-circuit on unchanged declarations and conclude there is nothing to do — with an
   *  empty surface. `stop()` followed by `start()` would then never bring the tools back. */
  function removeAll(): void {
    for (const [name, handle] of registered) {
      try { handle.remove(); } catch { /* transport already gone; the registry drop below still matters */ }
      unregisterTool(name);
    }
    registered.clear();
    lastPrint = '';
  }

  async function refresh(): Promise<{ reachable: boolean; registered: string[]; refused: Record<string, string> }> {
    const refused: Record<string, string> = {};
    let decls: ToolDecl[];
    try {
      const { status, body } = await ctx.call('/api/game-tools', undefined, 4_000);
      // No editor, an older editor without the route, or a renderer that is not up yet. All three
      // mean "no game tools right now", which is a normal state — not an error to report at every
      // poll. Drop whatever we had so the advertised surface never outlives the editor that
      // backed it: a tool that answers 504 forever is worse than one that is absent.
      if (status !== 200 || !body || typeof body !== 'object') {
        if (registered.size) removeAll();
        return { reachable: false, registered: [], refused: lastRefused };
      }
      decls = Array.isArray((body as { tools?: unknown }).tools) ? ((body as { tools: ToolDecl[] }).tools) : [];
    } catch {
      if (registered.size) removeAll();
      return { reachable: false, registered: [], refused: lastRefused };
    }

    const print = fingerprint(decls);
    if (print === lastPrint) return { reachable: true, registered: [...registered.keys()], refused: lastRefused };

    // Reconcile wholesale rather than diffing. The surface is a handful of tools, and a
    // remove-then-add is the only way a CHANGED schema (same name, new params) actually reaches
    // the client — `registerTool` would refuse the duplicate, and an in-place update would have
    // to reach into SDK internals.
    removeAll();

    for (const d of decls) {
      // Silently dropping a malformed entry is the failure this whole seam exists to remove: the
      // tool is simply absent and nothing anywhere says why. It cannot come from a well-behaved
      // game (the engine registry validates names at registration), so this is about an older or
      // corrupted backend — precisely when a reason is worth having.
      if (!d || typeof d.name !== 'string' || !d.name) {
        refused[`(malformed #${decls.indexOf(d)})`] = 'declaration has no usable name';
        continue;
      }
      const shape = shapeFromDecl(d.params);
      if (!shape) {
        refused[d.name] = 'declares a parameter type this server does not recognise';
        continue;
      }
      // A game tool naming an engine tool would throw out of `registerTool` and take the whole
      // poll down. Refuse it by name instead: the engine surface wins, and the game gets told.
      const handler = async (args: never): Promise<ToolResult> => {
        const r = await ctx.postJson('/api/game-tool-call', { name: d.name, args: args ?? {} }, 30_000, `the game tool ${d.name}`);
        return r;
      };
      try {
        const handle = defineTool(
          server,
          ctx,
          d.name,
          // Mark the provenance in the description. An agent choosing between `modoki_load_scene`
          // and `court_load_level` benefits from knowing one is the open project's own tool, and
          // that it vanishes when the project does.
          `[${d.mutates ? 'game tool, MUTATES' : 'game tool'}] ${d.description}`,
          shape,
          handler,
        );
        registered.set(d.name, handle);
      } catch (e) {
        refused[d.name] = e instanceof Error ? e.message : String(e);
      }
    }
    lastPrint = print;
    lastRefused = refused;
    const names = [...registered.keys()];
    process.stderr.write(
      `[modoki-mcp] game tools: ${names.length ? names.join(', ') : '(none)'}` +
        `${Object.keys(refused).length ? ` — refused: ${Object.entries(refused).map(([n, r]) => `${n} (${r})`).join(', ')}` : ''}\n`,
    );
    return { reachable: true, registered: names, refused };
  }

  function schedule(delay: number): void {
    if (stopped) return;
    timer = setTimeout(tick, delay);
    // Never hold the process open for a poll. Without this the server would outlive its own
    // stdio transport closing, which is how an orphaned MCP process ends up owning a port.
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    let reachable = false;
    try {
      reachable = (await refresh()).reachable;
    } catch { /* a poll must never throw into the timer */ }
    schedule(reachable ? POLL_OK_MS : POLL_DOWN_MS);
  }

  return {
    refresh,
    start: () => { stopped = false; schedule(0); },
    stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; removeAll(); },
    active: () => [...registered.keys()],
  };
}
