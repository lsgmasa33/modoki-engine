# Game-registered agent tools

**A game can put its OWN tools on the `modoki` MCP surface.** They appear beside the engine's
`modoki_*` tools, with real schemas, the same refusal envelope, and a place in `modoki_batch` —
and they come and go with the open project.

Introduced by [#270](https://github.com/lsgmasa33/modoki/issues/270). The worked example is
Court's level navigation (`games/court/runtime/agentTools.ts`).

---

## Why this exists

The MCP surface used to be a fixed list — `registerAllTools` walks a hardcoded `TOOL_GROUPS`. So
anything game-specific had two routes to an agent, and both are worse than a tool:

| Route | Why it falls short |
|---|---|
| A UIAction via `modoki_dispatch_action` | Untyped (one scalar `payload`), inert unless the sim is Playing, and it answers *"dispatched"* rather than answering the question. It also **cannot be aimed** when the argument lives in the firing entity's NAME — which is exactly why Court's `court.levelTilePick` cannot express "load level X": its 25 tiles are instances of one prefab, so the slot is read from `LevelTile_<slot>`. |
| The in-game debug menu | Keyboard-only, and F12 is swallowed whenever a DOM text field holds focus. Court's list is also indexed **two off** the on-disk manifest (`loadManifest` prepends the two tutorial lessons), which is invisible from the files and cost a live session a round trip on 2026-08-20. |

## The chain

```
game setup.ts
  registerAgentTool({ name, description, params, mutates, handler })   ← @modoki/engine/runtime
        │   runtime/debug/agentToolRegistry.ts  (pure; gated by isDebugMenuEnabled)
        ▼
  agent ops  game-tools (declarations)  ·  game-tool-call (invoke)     ← engine/app/debug/agentBridge.ts
        ▼
  GET /api/game-tools  ·  POST /api/game-tool-call                     ← plugins/backend/editorBackendRouter.ts
        ▼
  the MCP server materializes ONE REAL TOOL per declaration            ← tools/modoki-mcp/src/gameTools.ts
```

Both hosts (the Vite dev server and the Electron backend) run the same router, so this works in
the dev editor and the packaged one alike.

## Registering a tool

```ts
import { registerAgentTool, unregisterAgentTool, isDebugMenuEnabled } from '@modoki/engine/runtime';

if (isDebugMenuEnabled()) {
  registerAgentTool({
    name: 'court_load_level',          // FULL name — see "Naming" below
    description: 'Load a level by id or manifest index, bypassing the progress gate…',
    mutates: true,                     // required, no default — see below
    params: {
      levelId: { type: 'string', description: 'The level GUID. Takes precedence over index.' },
      index:   { type: 'number', int: true, description: '0-based manifest index.' },
    },
    handler: async (args) => ({ ok: true, /* … */ }),
  });
}
```

Unregister from the game's `unregisterSystems()`, exactly as you would `unregisterDebugTab` —
otherwise a switched-away game's tools linger.

### Params are a small closed set

`string` (optionally `enum`), `number` (optionally `int`), `boolean`; each with a `description`,
each optional unless `required: true`.

The set is small because **these declarations cross a process boundary** — renderer → backend →
the MCP server, which is a separate Node process over stdio. A game cannot hand over a zod schema;
it has to survive JSON. The server rebuilds a real zod shape from the declaration, which is what
keeps the strict-schema refusal working for game tools too.

⚠️ **An unrecognised param type refuses the WHOLE tool**, loudly, rather than degrading that one
param to `z.any()`. A silently-untyped param is how a typo becomes a different operation — the
reason the entire surface went strict after `modoki_set_selection {name:'Capsule'}` parsed to `{}`
and cleared the human's selection while reporting success.

### `mutates` is required and has no default

It decides whether the live tool sweep may call your tool against the human's open editor. A
default would be guessed wrong exactly once, and the cost of guessing "read" for a writer is
damage to an open project.

This is what buys game tools **real live coverage**: `test-live-tools.ts` asks the backend which
tools the open game declares, calls every `mutates: false` one, and skips the rest — the same rule
it applies to the static surface, answered from the declaration instead of from `contracts.ts`.

### `requiresPlaying` — so a correct refusal is not read as a defect

Set it when your tool cannot answer while the sim is stopped (Court's `court_level_info` has no
board to describe until the per-frame system has built one). The sweep uses it to classify a
`REFUSED_BY_OP` while the editor is stopped as a **state answer** rather than a broken tool.

Without it you get one of two bad outcomes, both of which this repo has already paid for: a
correct refusal reported as a defect on every run until people stop reading the output, or a
blanket acceptance of refusals that can no longer see a real one. Any *other* refusal from your
tool is still a defect, and so is this one while the editor **is** playing.

### Naming: `<gameId>_<verb>`

- `modoki_` is **reserved** — the registry throws on it.
- A game tool must start with its own game id. This is checked **statically**, by
  `engine/tests/architecture/gameAgentToolNames.test.ts`, and deliberately not at runtime: the
  registry is a pure module with no idea which game is calling, and checking at the bridge would
  mean a mis-named tool registers fine and then silently fails to appear — the invisible failure
  this seam exists to remove.

### Handler conventions

Return a JSON-serializable answer; it is passed through to the caller **untouched**, so your tool
answers its own question rather than having it buried in an envelope. On a refusal follow
[mcp-tool-conventions.md](./mcp-tool-conventions.md) §5 — `{ ok:false, reason, …options }`, naming
what *would* have worked — instead of throwing. A throw is caught and reported as
`ok:false`, so it never presents as a transport failure (a 504 reads as "the editor is gone" and
sends the agent diagnosing the wrong layer).

## Release builds

The whole registry is gated on `isDebugMenuEnabled()` — `listAgentTools()` and `getAgentTool()`
both return nothing when it is off. The gate covers **lookup as well as listing** on purpose: a
gate that only emptied the list would leave every tool fully drivable by anyone who knew its name.

So a release build exposes no agent tools even if a game registers them unconditionally. Gating
your own registration call as well (as Court does) is belt-and-braces, not the only guard.

## How they reach the agent — and why it is a poll

The MCP server polls `/api/game-tools` (5s while a backend answers, 30s while none does) and
sends the MCP `tools/list_changed` notification when the surface moves.

**A fetch at startup would not work**, and this is the load-bearing design point: the MCP server
is spawned with the Claude *session*, while the editor is launched later and swapped between
projects while that session runs. A startup-only fetch would find no editor in very nearly every
session, and the tools would be permanently invisible.

Two consequences worth knowing:

- **Tools appear a few seconds after the editor opens**, not instantly.
- **They are removed when the backend stops answering.** A tool that stayed advertised after its
  editor was gone would answer 504 forever, which is worse than being absent.

The poll compares a **fingerprint of the declarations**, not the registry's `version` counter
alone. That counter is per-renderer and resets to 0 on the page reload that every game `.ts` save
triggers — so a genuine change can move it *backwards*. Hashing the declarations also catches a
schema edited in place under an unchanged name.

## What guards this

A game tool has no `contracts.ts` entry — it is declared at runtime by whichever project is open —
so the contract-conformance guard cannot cover it. The **live sweep can and does**: it reads the
declarations from the backend and calls the non-mutating ones (see `mutates` above). What is left
uncoverable in CI is only the part that needs a running editor with that game open, which is true
of the static surface too.

What covers it instead:

| Guard | What it pins |
|---|---|
| `engine/tests/tools/mcpGameTools.test.ts` | Declaration → strict schema, unknown-type refusal, duplicate/engine-shadow refusal, routing to `/api/game-tool-call`, teardown when the backend goes away, re-registration on an in-place schema change |
| `npm run test:mcp:live` (needs an editor) | The tail is really on the surface, and every `mutates:false` game tool answers for real |
| `engine/tests/framework/agentToolRegistry.test.ts` | Name validation, the reserved prefix, the debug gate on **both** list and lookup, change notification |
| `engine/tests/architecture/gameAgentToolNames.test.ts` | `<gameId>_` namespacing across `games/` + `demos/`, no cross-project collisions |
| `games/court/tests/agentTools.test.ts` | The worked example's behaviour |

## Limits worth knowing before you rely on this

- **A game tool's mutation is not undoable.** Engine tools declare `undoable` in `contracts.ts` and
  push an undo entry; a game tool pushes whatever its handler pushes, which is usually nothing. So
  a human's Cmd-Z will not unwind it, and neither will `modoki_history`. `modoki_batch`'s per-step
  undo cannot reach it either. If your tool should be undoable, the handler has to do that itself.
- **There is no `device_*` twin.** The ops (`game-tools`, `game-tool-call`) live in `agentBridge`,
  which the device bridge also serves, so the *capability* is reachable on a phone — but the
  `game-debug` MCP is a separate server with its own static tool list and no dynamic tail, so a
  game's tools do NOT appear there. Deliberate scope, not an oversight; on device, drive them
  through `device_eval_api` or add the twin.
- **They appear a few seconds after the editor does**, and vanish with it. Do not write a script
  that assumes the tool exists the instant the MCP server starts.

## Verifying a change to this seam

The [CLAUDE.md rule](../CLAUDE.md) applies unchanged — after touching `engine/tools/**`, an
`/api/*` route or an agent op, launch an editor and run the live tiers. `npm test` cannot see a
dead route.

For this seam specifically, the live check that matters is the one only a live editor can answer:
**open a project that registers tools and confirm they appear on the MCP surface**, then confirm
they vanish when the editor stops. Perturbing a declaration and watching the schema follow is the
distinguishing observation — a tool that merely *exists* proves the registration path, not the
refresh path.
