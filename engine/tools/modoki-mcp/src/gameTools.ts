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

/** Consecutive misses required before `removeAll()` fires — for EITHER of two doors: the backend
 *  answering non-200, or a 200 that shrinks the tool list to empty. Both happen on a page reload
 *  (game-code edit): the renderer goes down and back through a handful of polls, and while it is
 *  back up but before `setup()` has run `registerCourtAgentTools()`, `/api/game-tools` answers 200
 *  with `{tools: []}` — a SUCCESS carrying an empty surface, not an unreachable poll. Reacting on
 *  the FIRST miss turns the blip into a `tools/list_changed` — and `tools` renders first in the
 *  prompt-cache prefix, so that one notification invalidates the whole conversation cache.
 *
 *  ⚠️ ONE counter, shared by both doors — so this is 3 misses of either kind COMBINED, not 3 per
 *  door: `504, 504, 200{tools:[]}` tears down on that first empty poll. That is deliberate. A
 *  reload is ONE disturbance that can present through both doors as the renderer goes down and
 *  comes back, and three consecutive unhealthy polls is the signal regardless of which door each
 *  one used; separate counters would double the window for the mixed case, which is the common
 *  one. Do not "fix" this into two counters without re-measuring a real reload. */
const UNREACHABLE_GRACE_POLLS = 3;

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
  /** Consecutive unreachable polls seen so far. Reset on any successful fetch, so the grace window
   *  is always UNREACHABLE_GRACE_POLLS FULL polls, not a rolling count since the last teardown. */
  let consecutiveFailures = 0;

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

  /** Shared unreachable-poll handling for both exits below: count the failure, and only tear down
   *  once the grace window is exhausted. Reports what is ACTUALLY still registered — during the
   *  grace window the tools are still live, and `[]` would be a lie to a caller asking "what do I
   *  have right now". */
  function onUnreachable(): { reachable: boolean; registered: string[]; refused: Record<string, string> } {
    consecutiveFailures++;
    if (registered.size && consecutiveFailures >= UNREACHABLE_GRACE_POLLS) removeAll();
    return { reachable: false, registered: [...registered.keys()], refused: lastRefused };
  }

  /** The shrink-to-zero twin of `onUnreachable()`: the backend answered — reliably 200, so this is
   *  NOT an unreachable poll — but with no tools, while some are still registered. Shares the
   *  counter and threshold so a genuine reload (`0 tools` sandwiched between real answers) gets the
   *  same grace as a transport blip. Does not need the `registered.size &&` guard `onUnreachable()`
   *  has: the call site already tested `registered.size > 0` before reaching here. */
  function onTransientEmpty(): { reachable: boolean; registered: string[]; refused: Record<string, string> } {
    consecutiveFailures++;
    if (consecutiveFailures >= UNREACHABLE_GRACE_POLLS) removeAll();
    return { reachable: true, registered: [...registered.keys()], refused: lastRefused };
  }

  async function refresh(): Promise<{ reachable: boolean; registered: string[]; refused: Record<string, string> }> {
    const refused: Record<string, string> = {};
    let decls: ToolDecl[];
    try {
      const { status, body } = await ctx.call('/api/game-tools', undefined, 4_000);
      // No editor, an older editor without the route, or a renderer that is not up yet. All three
      // mean "no game tools right now", which is a normal state — not an error to report at every
      // poll. Once the grace window is exhausted, drop whatever we had so the advertised surface
      // never outlives the editor that backed it: a tool that answers 504 forever is worse than
      // one that is absent — but a single blip (a page reload) must not churn the tool list.
      if (status !== 200 || !body || typeof body !== 'object') return onUnreachable();
      decls = Array.isArray((body as { tools?: unknown }).tools) ? ((body as { tools: ToolDecl[] }).tools) : [];
    } catch {
      return onUnreachable();
    }

    // #648 — partition BEFORE `fingerprint()` sees any of this, not after. `fingerprint()` used to
    // run over the raw reply, so a single malformed element (a bare `null`, which a corrupted or
    // older backend can legitimately send) threw straight out of `t.name` — a TypeError `tick()`'s
    // poll `catch` swallows silently, so game tools never registered and every later poll died at
    // the same line, breaking this module's own stated contract above ("a refused tool is
    // reported, not dropped quietly") for the WHOLE surface over one bad element. Silently
    // dropping a malformed entry is no better — the tool is simply absent and nothing says why —
    // so it goes in `refused` instead, same as it always has, and the reconcile loop below only
    // ever sees the well-formed rest.
    //
    // ⚠️ The partition must happen ABOVE every decision that used to read `decls`, and all three
    // of them now read `validDecls`. Review of the first cut caught two defects from leaving them
    // behind, both the same mistake — reasoning about the raw reply while acting on the filtered
    // set. See the individual comments below.
    const validDecls: ToolDecl[] = [];
    decls.forEach((d, i) => {
      // Index by POSITION, not `decls.indexOf(d)` — `indexOf` returns the FIRST match for
      // identical primitives, so `{tools:[null, null]}` wrote `(malformed #0)` twice and reported
      // two bad declarations as one.
      if (!d || typeof d.name !== 'string' || !d.name) {
        refused[`(malformed #${i})`] = 'declaration has no usable name';
        return;
      }
      validDecls.push(d);
    });

    // A successful fetch — even one that turns out to have an unchanged fingerprint below — is
    // proof the editor answered, so the grace window resets here rather than after the reconcile.
    // But only on a TOOL-BEARING answer: resetting on an empty 200 too would defeat the very grace
    // window `onTransientEmpty()` exists to give the shrink-to-zero transition below. A poll whose
    // every element was malformed is NOT tool-bearing, hence `validDecls`.
    if (validDecls.length > 0) consecutiveFailures = 0;

    // ⚠️ The fingerprint covers the REFUSED keys as well as the valid declarations. Fingerprinting
    // `validDecls` alone was a defect this fix introduced: a malformed element does not change the
    // valid set, so `print === lastPrint` took the early return below and handed back `lastRefused`
    // — `refused` is rebuilt per call and was never assigned — so a malformed declaration was
    // reported on NO poll, ever. That is the exact contract this partition exists to honour, broken
    // by the thing meant to honour it. The mirror case failed too: an entry reported once stayed in
    // `lastRefused` forever after the backend stopped sending it.
    const print = `${fingerprint(validDecls)}|${JSON.stringify(Object.keys(refused).sort())}`;
    if (print === lastPrint) return { reachable: true, registered: [...registered.keys()], refused: lastRefused };

    // A 200 with an empty tool list while some are still registered is the reload gap described
    // above (setup() hasn't called registerCourtAgentTools() yet) — give it the same grace as an
    // unreachable poll rather than tearing down immediately.
    //
    // ⚠️ `validDecls`, not `decls`: a poll answering only malformed entries reduces the usable set
    // to zero exactly like an empty one, so it must get the same grace. Keyed on `decls` it did
    // not — `decls.length` was 1, the guard was skipped, and a SINGLE corrupt poll tore down every
    // registered game tool with no grace window at all.
    if (validDecls.length === 0 && registered.size > 0) return onTransientEmpty();

    // Reconcile wholesale rather than diffing. The surface is a handful of tools, and a
    // remove-then-add is the only way a CHANGED schema (same name, new params) actually reaches
    // the client — `registerTool` would refuse the duplicate, and an in-place update would have
    // to reach into SDK internals.
    removeAll();

    for (const d of validDecls) {
      // `shapeFromDecl` now runs INSIDE this try too (#648) — it used to run outside, so a throw
      // from it (a registry-serialization edge case, current or future) would escape `refresh()`
      // the same way the fingerprint bug above did, rather than landing in `refused` like every
      // other per-tool failure here.
      try {
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
    // Keep the fast cadence while tools are still held, even mid-grace-window, so a genuine
    // recovery is prompt and the ~15s grace window stays ~15s rather than stretching toward 65s.
    // Only back off once the surface is actually empty — nothing left to watch closely for.
    schedule(reachable || registered.size ? POLL_OK_MS : POLL_DOWN_MS);
  }

  return {
    refresh,
    start: () => { stopped = false; schedule(0); },
    // An explicit stop is not a poll failure — tear down immediately, and reset the grace counter
    // so a later start() begins its own unreachable run from zero.
    stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; consecutiveFailures = 0; removeAll(); },
    active: () => [...registered.keys()],
  };
}
