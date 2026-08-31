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
| A UIAction via `modoki_dispatch_action` | Untyped (one scalar `payload`), inert unless the sim is Playing, and it answers *"dispatched"* rather than answering the question. Its `params` schema is **not** validated either — that field is documented as "editor-facing … drives typed widgets in the Inspector's binding editor", and only 8 of 68 registration sites declare one, so there is nothing to enforce against. It also **cannot be aimed** when the argument lives in the firing entity's NAME — which is exactly why Court's `court.levelTilePick` cannot express "load level X": its 25 tiles are instances of one prefab, so the slot is read from `LevelTile_<slot>`. |
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

### Where args are validated — and why it is not only in the MCP server

The MCP server rebuilds a zod shape from `params`, which is what puts a real schema in the tool
list. That used to be the *only* enforcement, and it made the declaration a promise kept for one
caller in four: `curl -X POST /api/game-tool-call`, `device_eval`'s `modoki.call`, and the device
relays all reached the handler with whatever they were given.

So the declaration is now enforced at the **op** (`validateAgentToolArgs`, beside the
`AgentToolParam` type that defines it), and every caller inherits it. The zod rebuild is the first
line of defence rather than the only one. Practical consequence for a game author: **your handler
can trust `args`** — an unknown key, a wrong type, a bad `enum` value or a missing `required` param
is refused before you are called, with a reason naming your real parameters.

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
- **`wait` is reserved too**, and it is the exception to "reserved means prefixed". It is
  `modoki_batch`'s pseudo-step, which a batch matches **before** consulting the registry — it has
  to, being the documented spelling and not a registry entry at all. So a game tool named `wait`
  would register cleanly, appear over MCP, and then be uncallable from any batch, the step
  silently sleeping instead. Registration is the only place that can be made loud, so
  `registerAgentTool` refuses that one exact name (`RESERVED_NAMES`). Neighbouring names
  (`court_wait`, `waiting_room`) are unaffected — it is a name, not a prefix.
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

The MCP server polls `/api/game-tools` (5s while a backend answers **or while any tool is still
held**, 30s only once the surface is actually empty) and sends the MCP `tools/list_changed`
notification when the surface moves.

**A fetch at startup would not work**, and this is the load-bearing design point: the MCP server
is spawned with the Claude *session*, while the editor is launched later and swapped between
projects while that session runs. A startup-only fetch would find no editor in very nearly every
session, and the tools would be permanently invisible.

Two consequences worth knowing:

- **Tools appear a few seconds after the editor opens**, not instantly.
- **They are removed after 3 consecutive misses (~15s), not the first one** — a miss being *either*
  a poll the backend does not answer *or* a 200 whose tool list has gone empty. Both happen during
  the page reload a game `.ts` save triggers, so both get the grace; a **non-empty** change still
  reconciles at once, because a changed schema must reach the client immediately. A tool that
  stayed advertised after its editor was gone would answer 504 forever, which is worse than being
  absent — but a single miss must not tear the surface down. **A project SWAP pays that same ~15s**:
  the outgoing project's tools stay advertised until the grace expires, and a call to one in that
  window is REFUSED by the renderer (the name is gone from its registry) rather than doing something
  wrong. ⚠️ **Register a game's tools in ONE synchronous batch**, as Court and Wordweave both do —
  the grace covers a shrink to *zero*, so a registry observed mid-population (tools split across an
  `await` or two lifecycle points) would churn the surface on every reload. That grace exists
  because a
  teardown emits `tools/list_changed`, and `tools` renders first in the prompt-cache prefix, so it
  invalidates the whole conversation cache: see
  [mcp-response-budget.md](./mcp-response-budget.md) § "Definition surface under tool deferral".

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
| `engine/tests/framework/gameToolCallOp.test.ts` | The op enforces the declaration for every non-MCP caller — a typo is refused, the handler is never reached |
| `engine/tests/tools/deviceTwinDrift.test.ts` | The device relays send the right op, name no specific game, and refuse in the caller's terms |
| `engine/tests/tools/mcpGameTools.test.ts` (conformance) | The zod rebuild and the op-side validator agree on 12 accept/reject cases — one declaration, two implementations, no shared code |
| `engine/tests/framework/agentToolRegistry.test.ts` | Name validation, the reserved prefix, the debug gate on **both** list and lookup, change notification |
| `engine/tests/architecture/gameAgentToolNames.test.ts` | `<gameId>_` namespacing across `games/` + `demos/`, no cross-project collisions |
| `games/court/tests/agentTools.test.ts` | The worked example's behaviour |

## Writing a handler that runs on a phone

**Your tool inherits the device bridge's 5000 ms request budget** (`deviceConnection.ts`'s
`REQUEST_TIMEOUT_MS`), and only two tools on the whole device surface can raise it —
`device_eval` and `device_step`, both by passing an explicit `timeoutMs`. A game tool cannot.

That ceiling is easy to miss because the same handler is fast everywhere else. Court's shape
scan measured **495 ms** in the desktop editor, **2701 ms** on a Galaxy S22 and **~30 ms/file**
on a Galaxy A23 — 13x the S22, roughly 33 s for the same work. On the A23 it ran straight past
the deadline: the work *completed on the device* while the reply arrived too late to read, so the
caller saw a timeout and the next identical call answered in 134 ms from a warm cache.

So if your handler's work scales with anything — corpus size, entity count, an O(n²) pass —
**give it a wall-clock budget and report that you stopped**, the way `court_list_levels` returns
`capped: true, cappedBy: "time"` with the count it did read. A tool that times out and then
succeeds is worse than one that answers a smaller question honestly. Use `rawNow()` from
`@modoki/engine/runtime` (the sanctioned wall-clock wrapper; `setManualNow` makes the budget
testable), not `Date.now()`.

## Court's placement tools — the guard-completeness trap (#339)

Court's second pair of tools (`court_place_piece`, `court_board_state`) is worth reading before you
write a game tool that DRIVES gameplay rather than navigating it, because the obvious
implementation is wrong in a way nothing catches.

**The state function is not the whole operation.** Court's `commitPlace(piece, cell)` does the full
job of landing a piece — memo wipe, heart charge, journal, revert-arm, save. It looks like exactly
the seam a tool should call. But the guards a real drop passes live in its **callers**: cell
emptiness is checked in `onRelease`, tray exhaustion in `onPressAt` before a drag can even begin.
Calling `commitPlace` bare therefore lets an agent **over-place a piece type**, which fails rule 1
`wrong-piece-count` — an END-STATE violation, so nothing flashes, nothing reverts, and the board can
look solved while being illegal. That is the [§0 rank-1 false
success](mcp-tool-conventions.md#0-the-rule-that-generates-the-others).

So the rule generalises: **find the guards in the caller, not just the state function, and
re-assert every one.** A game tool that reproduces a player action must reproduce what the player
*cannot* do as faithfully as what they can.

⚠️ **"The caller" is not one function, and this is where the first attempt failed review.** Court's
guards live at *three* depths: two module-level gates in `onPressAt` (intro running, menu open), the
emptiness check in `onRelease` — and six more inside **`hitTest`**, which answers with a *backdrop*
target rather than a cell whenever the board is untargetable (solved, Game Over, a hint story
playing, a tutorial narration beat, the `(i)` reference open, a flyout open). The first
implementation walked the first two and stopped, so the tool would happily land a piece on a **Game
Over board** — writing the player's saved session behind an overlay they cannot dismiss — and place
a piece *underneath* a hint story, leaving the narration describing a position that no longer
existed. A green suite saw none of it.

The fix that holds is not a longer list at the call site but **one predicate both paths read**
(`boardInputBlocker()`), because the same disjunction had already been hand-copied a third time into
the hit-region provider. When you find yourself enumerating "states where input is refused" in a
tool, that list almost certainly already exists somewhere in the input path — share it rather than
restate it, and the next state added lands in both places at once.

⚠️ **And there may be a layer the engine never sees at all.** Court blocks the board in *two*
places: the engine list above, and the **DOM** — `UIRenderer`'s pointer-blocker swallows a press
over a scene-authored overlay before `hitTest` ever runs. Court's region-chip flyout is blocked only
that way (it is dismissed by a scene `UIAction`, not a hit-test branch), so it appears in no engine
predicate, and a tool that checked only the engine could place a piece "through" an open flyout that
a real finger cannot reach past. **A synthetic call bypasses every layer, so it has to ask every
layer** — enumerate the DOM-modal overlays too, and keep that check separate rather than folding it
into the engine predicate, since widening the engine one would change real input behaviour.

**Then test the refusals, not just the successes.** The differential test covered the six cases
anyone would think of (occupied, hole, exhausted…) and none of the six above, which is exactly why
the gap survived. A guard with no test is how the copy drifts back apart.

One case in that test deliberately asserts the two arms **disagree**: headless has no DOM, so the
gesture arm is the *unfaithful* one for a DOM-blocked overlay. Say so loudly in the test, or the
next reader will "fix" the divergence away and reopen the hole.

**Reproduce the input path, do not invent rules.** The sharp pair in Court: a **hole** is refused
(it gets no `cellCenters` entry, so a real drag cannot hit-test it either) while a **civilian cell
is allowed to land** (it is hit-testable, and the resulting rule-5 violation with its ✕ and heart
cost is exactly what QA needs reachable — it was a real shipped bug, #47). The tool never
pre-judges legality; it lands the drop and reports the game's own verdict, read off `pendingRevert`
rather than re-derived.

**Duplicated guards need a differential test.** Because the guards now exist in two places,
`games/court/tests/agentToolsPlacement.test.ts` drives the real gesture machine and the tool side
by side on one fixture board and asserts they reach the same outcome on both axes (did a placement
land, did a revert arm). Cases the gesture cannot express at all — a hole has no screen point to
aim at — are asserted as that impossibility rather than skipped. Without this, the copy drifts;
Court has been bitten twice by hand-copied predicates diverging from the code they copied.

**Say when a tool writes the player's data.** `court_place_piece` ends in `saveSession()`, so it
overwrites the human's stored board — unlike Court's three navigation tools, whose file banner
declares they never write progress. That banner had to be rewritten rather than left standing: a
declared invariant that a new tool quietly breaks is worse than one that was never written down.

### Phase 2: `court_move_piece` — a separate tool, not an optional param (#339)

Move (cell→cell) reuses everything above rather than re-deriving it, and adds two lessons of its
own.

**An optional param that can be forgotten is a different-operation-reported-as-success waiting to
happen.** The obvious shape for "move" is an optional `from` on `court_place_piece`. It was
rejected: forgetting `from` silently turns an intended move into a fresh tray placement — the exact
§0 rank-1 false-success class this whole feature keeps tripping over. `court_move_piece` is its own
tool with `from`/`to` both *required*, so there is no path that forgets one.

**The guard preamble is shared through a function, not a fourth hand-copy.** `agentPlacePiece` had
all six board-touchability checks (no level, sim stopped, intro/menu, `boardInputBlocker`,
`domModalOverBoard`, a refusal already on screen) inline — and a second tool needing the identical
run would have been the fourth copy of that disjunction in this file (`hitTest`, the hit-region
provider and `agentPlacePiece` were the first three, and two review rounds exist because they had
already drifted apart once). `agentBoardGate()` extracts it; both `agentPlacePiece` and
`agentMovePiece` call it, and neither hand-copies a guard the other already checks.

⚠️ **`domModalOverBoard` is GONE as of #355 — the tool layer no longer carries its own second
predicate.** It existed because Court's engine-side blocker (`boardInputBlocker`, which `hitTest`
reads) covered only 7 of 10 modal states: the region-chip flyout, the settings panel and the rules
reference blocked from the DOM alone, so a *tool* had to ask a second question the *input* layer
could not answer. That split was the defect, not the design — it meant a headless test could drive
a board tap no player can perform and pass, and `courtHitRegionsDesign()` listed covered cells as
available targets, i.e. the invariant was false rather than merely unenforced. The three states now
have engine branches, so the tools inherit the coverage from the one shared list like every other
state, and the refusal reports the real kind (`chip-backdrop` / `dom-modal-backdrop`) instead of a
tool-only `dom-overlay`. **Anything else driving `hitTest` is now protected too**, which the old
arrangement could not promise. One deliberate limit: the settings and rules branches **swallow**
where the DOM dismisses — their *dismissal* is stated by a scene `set` binding, so closing them from
`fireTap` would duplicate a rule the scene already owns and would let a refused agent placement close
a panel the player is reading. (The split is about who owns the dismissal, not about who ever writes
the field: `startTutorialReplay` hides `SettingsRoot` from code.) The chip flyout *does* dismiss,
because `chipFlyoutPiece` is Court's own module state.

**`piece` is an assertion, not a second address.** When given, it must match whatever is actually
standing at `from` — a real drag grabs whichever piece is under the finger, never a piece named in
advance. Given and mismatched, the tool refuses rather than silently moving the *actual* occupant.

**A move has a restore surface a placement does not.** `commitMove` is a retreat-and-place recorded
as one Action (memo.md's #85 scope update), so leaving `from` can give back notes that piece's
original landing there wiped — `court_move_piece` reports this as `memoRestored`/
`chipNotesRestored`, alongside the destination-side `memoCleared`/`chipNotesCleared` Phase 1 already
had. An agent that only read the destination fields would miss half of what the move just did.

### Phase 3: `court_recall_piece` — smaller on purpose (#339)

Recall (cell→tray) reuses `agentBoardGate()` exactly as move does, and takes only a source cell — a
real drag recalls whenever a board-origin drop ends on anything that is NOT a cell, so there is no
destination to name or judge.

**A result type should not carry fields the operation cannot produce.** Removing a piece can never
violate a rule, so `commitRecall` never arms `pendingRevert` — no `accepted`, no `refusedByGame`, no
`hearts.lostThisPlacement` on the response. A field that can only ever hold one value is noise, and
an eternal `refusedByGame: null` would invite a caller to read it as meaning something. The report is
restore-only: `memoRestored`/`chipNotesRestored`, computed by `commitRecall` *after* the recall is
applied so the restore judges the board the retreat actually leaves behind.

**The tutorial gate still applies, even though the lesson script never judges a recall.**
`commitRecall` never calls `judgeTutorialMove` — there is no destination for a script to assert
against — but `onPressAt`'s `wouldLift` still gates which piece may be *lifted* in the first place,
gate's-own-piece-on-the-board included. `agentRecallPiece` re-asserts that lift gate the same way
`agentMovePiece` does, or a synthetic call could pull a piece off the board mid-lesson that no real
drag could ever lift.

## Limits worth knowing before you rely on this

- **A game tool's mutation is not undoable.** Engine tools declare `undoable` in `contracts.ts` and
  push an undo entry; a game tool pushes whatever its handler pushes, which is usually nothing. So
  a human's Cmd-Z will not unwind it, and neither will `modoki_history`. `modoki_batch`'s per-step
  undo cannot reach it either. If your tool should be undoable, the handler has to do that itself.
- **On device you get two static relays, not the dynamic tail** (#286): `device_game_tools` lists
  what the connected build declares, `device_game_tool_call {name, args}` invokes one. The game's
  tools do **not** appear individually in the device tool list, and that is deliberate — the
  `game-debug` MCP is a thin client of the lease with a static surface, and a tail keyed to *which
  phone is leased and what build it carries* is far more volatile than one keyed to the open
  project (the eval-api guidance already warns "an older app reports fewer ops"). A phone running a
  build older than #270 has neither op; `device_eval`'s `modoki.call('game-tool-call', …)` reaches
  the same place and always has.
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
