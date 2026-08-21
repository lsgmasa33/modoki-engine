/** Agent-tool registry — the extensibility seam that lets a GAME put its own tools on the
 *  `modoki` MCP surface, beside the engine's `modoki_*` ones.
 *
 *  WHY THIS EXISTS: the MCP surface was a fixed list. `registerAllTools` walks a hardcoded
 *  `TOOL_GROUPS`, so anything game-specific had exactly two ways to reach an agent, and both
 *  are worse than a tool:
 *
 *    - a UIAction via `modoki_dispatch_action` — untyped (one scalar `payload`), inert unless
 *      the sim is Playing, and it answers "dispatched" rather than answering the QUESTION. It
 *      also cannot be aimed when the firing entity's NAME carries the argument, which is
 *      exactly why Court's `court.levelTilePick` cannot express "load level X" (#270).
 *    - the in-game debug menu — keyboard-only, and F12 is swallowed whenever a DOM text field
 *      holds focus.
 *
 *  A game registers here instead, and the tool shows up as a real MCP tool with a real schema,
 *  a real refusal envelope, and a real place in `modoki_batch`.
 *
 *  PURE, deliberately — only `isDebugMenuEnabled` is imported, and that module is itself pure.
 *  Like `debugMenuRegistry`, this is safe to re-export from the main runtime index: a
 *  game gets `registerAgentTool` from `@modoki/engine/runtime` without dragging any agent/MCP
 *  machinery into its eager bundle. The bridge that SERVES this registry lives in the app shell
 *  (`engine/app/debug/agentBridge.ts`) and reads it through these accessors.
 *
 *  Nothing here talks to the MCP server. The chain is:
 *      registerAgentTool()  →  agent op `game-tools` / `game-tool-call`
 *                           →  /api/game-tools, /api/game-tool-call
 *                           →  the MCP server materializes one real tool per declaration.
 *
 *  See docs/agent-tools.md and docs/debug-tools-mcp.md.
 */

import { isDebugMenuEnabled } from './debugMenuRegistry';

/** A parameter's declared type. Deliberately a SMALL closed set.
 *
 *  These declarations cross a process boundary (renderer → backend → the MCP server, which is a
 *  separate node process over stdio), so a game cannot hand over a zod schema — it would have to
 *  survive JSON. The MCP server rebuilds a real zod shape from this, which is what keeps the
 *  strict-schema refusal (`registerAll.ts`) working for game tools too. Widen this set only with
 *  a matching case in the server's builder; an unknown type is REFUSED rather than passed
 *  through as `z.any()`, because a silently-untyped param is how a typo becomes a different
 *  operation. */
export type AgentToolParam =
  | { type: 'string'; description: string; required?: boolean; enum?: readonly string[] }
  | { type: 'number'; description: string; required?: boolean; int?: boolean }
  | { type: 'boolean'; description: string; required?: boolean };

export interface AgentToolDef {
  /** The tool's FULL name, exactly as it will appear over MCP (e.g. `court_load_level`).
   *
   *  The game supplies the whole name rather than a bare verb the engine namespaces, so there is
   *  no synthesized prefix that can drift from what the agent actually calls. The convention —
   *  and the bridge enforces it — is `<gameId>_<verb>`. */
  name: string;
  /** What the tool does, in the CALLER's terms. This is the only thing an agent sees before
   *  choosing it, so say what question it answers and what it returns. */
  description: string;
  /** Declared params. Omit for a no-argument tool. */
  params?: Record<string, AgentToolParam>;
  /** Does a successful call CHANGE anything (world, scene, progress, files)?
   *
   *  Required, with no default, on purpose: it decides whether the live tool sweep may call this
   *  tool against the human's open editor. A default would be guessed wrong exactly once, and the
   *  cost of guessing "read" for a writer is damage to an open project. */
  mutates: boolean;
  /** Does this tool need the sim to be PLAYING to answer?
   *
   *  Declared, not inferred, because the live tool sweep has to tell "refused because the editor
   *  is stopped" (a state answer, and correct) from "refused because the tool is broken" (a
   *  defect). The static surface answers that from `contracts.ts`'s `requires`; a game tool has no
   *  contract, so it says so here. Without it the sweep either reports a correct refusal as a
   *  defect every run — and gets ignored — or blanket-accepts refusals and stops being able to see
   *  a real one. */
  requiresPlaying?: boolean;
  /** Runs in the renderer with the game's own imports in scope. Return a JSON-serializable
   *  answer. Convention (`docs/mcp-tool-conventions.md` §5): on a refusal return
   *  `{ ok:false, reason, ...options }` — naming what would have worked — rather than throwing. */
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const tools = new Map<string, AgentToolDef>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

/** Names an agent tool may not take. `modoki_` is the engine's own surface: a game tool taking
 *  one would either collide (the MCP registry throws on a duplicate) or, worse, land in the gap
 *  where the engine has not defined that name YET and would silently lose it later. */
const RESERVED_PREFIX = 'modoki_';
/** Names the engine's own agent surface already means something by, so a game tool cannot take
 *  them even though they carry no reserved prefix.
 *
 *  `wait` is `modoki_batch`'s pseudo-step (`tools/modoki-mcp/src/batch.ts`), and the batch matches
 *  it BEFORE consulting the registry — it has to, being the documented spelling and not a registry
 *  entry. So a game tool named `wait` would register cleanly, appear over MCP, and then be
 *  unreachable from every batch, with the step silently sleeping instead. Refusing the name at
 *  registration is the only place that failure can be made loud. */
const RESERVED_NAMES = new Set(['wait']);
/** MCP tool names are addressed as bare identifiers by `modoki_batch` and by the client. */
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Register (or replace, by name) a game-owned agent tool.
 *
 *  THROWS on a malformed or reserved name rather than dropping it. A registry that quietly
 *  ignores a bad entry produces the worst failure this repo has: the tool simply never appears,
 *  the game looks correctly wired, and nothing anywhere says why. The throw fires in the game's
 *  own `registerSystems()` in dev, which is where it can actually be fixed. */
export function registerAgentTool(def: AgentToolDef): void {
  if (!NAME_RE.test(def.name)) {
    throw new Error(
      `registerAgentTool: '${def.name}' is not a valid tool name — use lower_snake_case ` +
        `starting with a letter, and prefix it with your game id (e.g. 'court_load_level').`,
    );
  }
  if (RESERVED_NAMES.has(def.name)) {
    throw new Error(
      `registerAgentTool: '${def.name}' is reserved by the engine's agent surface (it is ` +
        `modoki_batch's pseudo-step, which a batch matches before the registry, so a tool by ` +
        `this name could never be called from one). Prefix game tools with your game id instead.`,
    );
  }
  if (def.name.startsWith(RESERVED_PREFIX)) {
    throw new Error(
      `registerAgentTool: '${def.name}' uses the reserved '${RESERVED_PREFIX}' prefix, which ` +
        `belongs to the engine's own tool surface. Prefix game tools with your game id instead.`,
    );
  }
  tools.set(def.name, def);
  bump();
}

/** Remove a tool by name — call from a game's `unregisterSystems()` on game switch, the same
 *  way `unregisterDebugTab` is called, so a switched-away game's tools do not linger. */
export function unregisterAgentTool(name: string): void {
  if (tools.delete(name)) bump();
}

/** Every registered tool, or NONE when the debug menu is disabled.
 *
 *  The gate lives here rather than at each registration site so a game cannot forget it: a
 *  release build exposes no agent tools even if the game registered some unconditionally. This
 *  mirrors how `isDebugMenuEnabled` gates the debug menu itself (docs/debug-menu.md). */
export function listAgentTools(): readonly AgentToolDef[] {
  if (!isDebugMenuEnabled()) return [];
  return [...tools.values()];
}

/** Look a tool up for invocation. Gated identically to {@link listAgentTools} — a tool that
 *  cannot be listed must not be callable either, or the gate would only hide the surface while
 *  leaving it fully drivable by name. */
export function getAgentTool(name: string): AgentToolDef | undefined {
  if (!isDebugMenuEnabled()) return undefined;
  return tools.get(name);
}

/** Check `args` against a tool's DECLARED params. Returns a caller-facing reason, or null when
 *  the args are acceptable.
 *
 *  WHY THIS LIVES HERE AND NOT IN A CALLER. The declaration promises a strict schema, and for a
 *  while exactly ONE caller kept that promise: the MCP server rebuilds a zod shape from `params`,
 *  so a typo'd key is refused there. Every other path into `game-tool-call` — the `curl` API,
 *  `device_eval`'s `modoki.call`, the device MCP relays — reached the handler with whatever it was
 *  given. A declaration honoured by one of four callers is the partially-wired authoring surface
 *  this repo keeps getting bitten by: the field exists, the docs describe it, and most of the ways
 *  in ignore it.
 *
 *  So the rule is enforced beside the {@link AgentToolParam} type that defines it, and the MCP's
 *  zod rebuild becomes the FIRST line of defence rather than the only one — it still earns its
 *  place by putting a real schema in the tool list, where the model can see it before calling.
 *
 *  STRICT about unknown keys, deliberately, for the reason the whole `modoki_*` surface is: for a
 *  tool whose params are all optional, silently dropping an unrecognised key turns a typo into a
 *  DIFFERENT operation that reports success. */
export function validateAgentToolArgs(
  def: AgentToolDef,
  args: Record<string, unknown>,
): string | null {
  const params = def.params ?? {};
  const declared = Object.keys(params);
  for (const key of Object.keys(args)) {
    if (!(key in params)) {
      return `'${key}' is not a parameter of ${def.name}. It accepts: ${declared.length ? declared.join(', ') : '(no parameters)'}.`;
    }
  }
  for (const [key, spec] of Object.entries(params)) {
    const value = args[key];
    if (value === undefined) {
      if (spec.required) return `${def.name} requires '${key}' (${spec.type}).`;
      continue;
    }
    if (spec.type === 'string') {
      if (typeof value !== 'string') return `'${key}' must be a string.`;
      if (spec.enum && !spec.enum.includes(value)) {
        return `'${key}' must be one of: ${spec.enum.join(', ')}.`;
      }
    } else if (spec.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `'${key}' must be a number.`;
      if (spec.int && !Number.isInteger(value)) return `'${key}' must be a whole number.`;
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') return `'${key}' must be true or false.`;
    }
  }
  return null;
}

/** Subscribe to registry changes. The bridge uses this to bump {@link agentToolsVersion}, which
 *  is what lets the MCP server notice a new surface and send `tools/list_changed`. */
export function subscribeAgentTools(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Monotonic revision of the registry — changes whenever a tool is added or removed. */
export function agentToolsVersion(): number {
  return version;
}

/** Test-only: drop every registration. Module-level state outlives a test file otherwise. */
export function clearAgentTools(): void {
  tools.clear();
  bump();
}
