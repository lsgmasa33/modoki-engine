# MCP tool conventions

**Normative.** These are the rules every Modoki agent tool obeys — the `modoki_*` MCP, the
`device_*` MCP (tool catalog for both: [debug-tools-mcp.md](debug-tools-mcp.md)), and the
dev-server `curl` API. One rule per subsection, each with the
reason it exists and, where applicable, the finding that produced it
([the audit ledger](reviews/2026-07-30-mcp-tool-audit.md)).

This doc exists because "each tool is individually reasonable" is not the same as "the surface is
coherent". A tool that does the same job a different way from its sibling costs an agent a wrong
guess, and an agent's wrong guess usually ends in a confident wrong answer to a human. Cross-tool
consistency is therefore a correctness property here, not a style preference.

Machine-readable companion: **`engine/tools/modoki-mcp/src/contracts.ts`** holds one contract per
tool and `engine/tests/tools/mcpToolContracts.test.ts` enforces the rules below that can be
enforced. A rule that can be a test IS a test — prose alone has already been shown to drift.

## 0. The rule that generates the others

> **An agent must never be told a wrong thing.**

Ranked consequences, worst first:

1. **A false success** — the call reports `ok` and the thing did not happen. The agent builds on it,
   and everything after is wrong. This is the worst outcome on an agent surface and outranks every
   other concern in this document, including backwards compatibility.
2. **A wrong answer stated authoritatively** — "no release is published" when the truth is "we could
   not look" (S1 `modoki_ota_status`). Indistinguishable from fact, so it cannot be recovered from.
3. **A partial success reported as complete** — worse than a clean failure, because the agent has no
   signal to retry (S1 `modoki_save_all`, `modoki_import_file`).
4. **An unclear failure** — "it didn't work". Recoverable but expensive.
5. **An inconsistency** — costs a guess.

A rule below that conflicts with a lower-ranked concern wins. "This would be a breaking change" does
not outrank #1.

## 1. Validation: strict, on every call path

**Every tool validates its arguments strictly, on every path a call can arrive by.** An unknown or
misspelled key is a **refusal** naming the tool's real parameter names — never silently dropped.

Why: zod strips unknown keys by default, and the MCP SDK builds a plain `z.object` (no `.strict()`)
— verified in `@modelcontextprotocol/sdk`'s `objectFromShape` (`.../zod-compat.js`). For a tool
whose params are all optional, that turns a typo into **a different operation**:
`modoki_set_selection {name:'Capsule'}` (no such param) parses to `{}`, which that tool documents as
"no refs = clear", so it **clears the human's selection and reports success**. That was measured,
fixed for `modoki_batch`'s pre-flight — and left in place for every direct call, which is where
most calls happen (V2).

Corollaries:
- `modoki_batch`'s envelope itself is strict too, including **inside** each step object: `arg` for
  `args` currently runs the step with no arguments (S1.batch).
- A tool with all-optional params and a destructive interpretation of `{}` is a hazard by
  construction (§7).
- **A shared zod schema object used for TWO sibling params dedupes into a `$ref` in the advertised
  inputSchema — even for a bare `z.boolean()`, not just objects.** `zod-to-json-schema` (what
  builds the JSON a client sees) does this by REFERENCE, not by structural shape, so it bit
  `modoki_dnd`'s `from`/`to` (a whole object collapsed to `{"$ref":"#/properties/from"}`), then
  `modoki_drag`'s shared `pointSpec.allowOccluded` one field deeper after the first fix, then
  `modoki_mutate_scene`'s `entity` field shared across three `discriminatedUnion` variants — three
  instances of one mistake, the last two found only by writing the guard. A client that doesn't
  resolve `$ref` reads that field as untyped and can encode it wrong (a real object arg failing
  validation as "Expected object, received string"). **Every param a tool shares across two or
  more sibling slots (`from`/`to`, union variants, …) must be built by a FACTORY FUNCTION called
  fresh at each use site** (`makeEntitySpec`/`makePointSpec`/`makeDndEndpoint` in `shapes.ts`), all
  the way down — a factory whose OWN fields still reference a shared const just moves the bug one
  level deeper. Guarded: `engine/tests/tools/mcpSchemaNoRef.test.ts` walks every registered tool's
  real schema and fails on any `$ref` found anywhere in it.

## 2. One name, one meaning

**A field or parameter name means the same thing in every tool that uses it.** If two tools need
different meanings, they need different names.

Violations that produced this rule:
- **`entityCount`** — "rows returned after the default filters" in `get_scene_state` vs "every
  entity in the world" in `get_editor_state`. 136 vs 137 on the same world, at the same instant, with
  nothing saying so. The most natural verification an agent can run — mutate, then compare counts —
  disagrees by a constant it cannot see, and the honest reading of that is "my edit did not land" (F8).
- **`onScreen`** — "inside the viewport" for 2D/3D, but merely "has non-zero size" for UI entities,
  so a UI element parked far off-screen reports `onScreen:true` (S1 `get_layout_bounds`).

### 2a. The TOOL name is the whole interface when schemas are deferred

**A tool's name must distinguish it from its neighbours without its description**, because an agent
often cannot see the description. Claude Code advertises this surface **deferred** — names only,
schemas fetched on demand ([mcp-response-budget.md](./mcp-response-budget.md) § "Definition surface
under tool deferral") — so a name is chosen from a list of ~148 strings and nothing else. A pair
that reads the same at that width is a coin flip, and §0 ranks a wrong action above an unclear one.

Audit of the whole surface, 2026-08-31 (24 lexically-similar pairs examined; most are fine —
`get_scene_state`/`get_editor_state`, the five `open_*_editor`, and the read/write pairs all carry
their distinction in the name). **Four did not** — the first is now fixed, the other three are a
recorded decision (both below):

| pair | why it is a coin flip | severity |
|---|---|---|
| `game_view_devices` (read) vs `game_view_device` (**mutating**) — *fixed, see below* | one character — a plural — separated a list from a write | **highest**: the boundary crossed is read↔mutate |
| `eval` (**mutating**) vs `eval_api` (read) | `_api` reads as "eval, via the API"; it is the **discovery/list** call. Both servers | high |
| `create_asset` vs `create_registered_asset` | "registered" names an implementation fact, not the difference an agent picks on (scaffold-with-defaults vs the Assets panel's "New X" kinds) | medium |
| `focus` (keyboard/panel focus) vs `focus_entity` (camera framing) | bare `focus` does not say *what* is focused | low |

Related inconsistency, same audit: `set_skin_mode` carried the `set_` prefix its siblings
`scene_view_mode` and `animation_view_mode` did not, though all three are mutating setters.

**The rule that audit produced — a mutating setter is named `set_*`** (#483, landed 2026-08-31).
`scene_view_mode`, `animation_view_mode`, `game_view_device`, `gizmo` and `collider_edit` were
renamed to `set_scene_view_mode`, `set_animation_view_mode`, `set_game_view_device`, `set_gizmo` and
`set_collider_edit`, joining `set_transform`, `set_selection`, `set_timescale`, `set_playhead` and
`set_skin_mode`. That also **dissolves the highest-severity row above**: a plural is no longer what
separates the list from the write — `set_` is, and `game_view_devices` is left unambiguously the
read. The split itself was always correct (§4 — the read half is a GET); only the naming was.

**The rule is a GUARD, not prose** (`mcpRegistry.test.ts`, "a tool whose backend op is `set-*` is
NAMED `modoki_set_*`"). The discriminator is the backend op, so a new `set-*` op cannot ship under
a non-`set_` name. That mechanism exists because the issue's own list was **incomplete**: it named
three tools, and the close-out sweep found `gizmo` (op `set-gizmo`) and `collider_edit` (op
`set-collider-edit`) — `gizmo` nine lines above the renames, in the same file. A rule
carried only by prose is a rule the next audit re-discovers.

Two families are deliberately OUT of scope, so nobody "fixes" them into the guard:
- **The `asset`-kind writers** — `particle_set`, `timeline_set`, `anim_set_clip`, `anim_add_key`,
  `timeline_add_clip`. These are **subject-first on purpose** (`anim_*`, `timeline_*`, `particle_*`)
  so a family sorts together in a name-only list, which is the same deferral pressure the `set_`
  rule serves. Their names match their ops exactly, and their ops are not `set-*`.
- **`select_sprite_slice`** — a genuine `select-` verb, not a setter.

⚠️ **The other three rows stay UNFIXED, and that is a decision, not a backlog.** All three fail
**recoverably** — you get the wrong read, notice, and call the right tool — and there is no observed
instance of an agent picking wrong; the audit is theoretical risk, while every fix is a RENAME
touching the contracts table, the generated catalog, `liveCoverage`, and every doc and test naming
the tool. That is the same cost that made §7 decline splitting `watch` and the journals. They stay
recorded so a *new* tool does not add a fifth. **When naming a new tool, the test is: could an agent
seeing only this name and its neighbours pick wrong?**
- **`position`** — documented as "World position" on `set_transform` while writing `Transform.x/y/z`,
  which is **local**. Every parented entity silently lands somewhere else, reported as success (S1).

Worked example, and the sharpest one on this surface — **`force` used to mean two things**
(closed 2026-08-22). On `build` / `add_native_target` / `ota_publish` it is harmless: your unsaved
work is left alone and merely not included in the artifact. On the world-swapping tools it
DESTROYED that work — from the world, the file *and* the undo stack — and the tool's own name gave
no clue which flavour you were getting. The failure that made it worth a breaking rename: an agent
uses `force` on a build (safe, nothing lost), learns *"force = proceed despite unsaved work"*, then
meets `load_scene`'s `REQUIRES_SAVE` refusal and passes it on the same understanding. The
destructive half is now **`discardUnsaved`** — named for the consequence, so the habit cannot
transfer — and §1's strict schema turns the old spelling into a refusal rather than the destructive
act.

Two lessons outlast the rename:
- **An exemption silences the guard, so each one must earn its place in writing.** `force` sat on
  `PER_TOOL_MEANING` (the "this name genuinely means different things per tool" list) and the
  containment check below was therefore blind to it — which is how the same violation on
  `modoki_render_sequence` survived until it was found by hand. The list is a holding pen, not a
  home; `force` has left it.
- **A shared param helper APPENDS, never prepends.** Getting `force` off the list needed its three
  surviving uses to read identically, so `unsavedForceParam` dropped its per-tool verb
  ("Build"/"Scaffold"/"Publish"): three strings differing in their FIRST word contain none of each
  other, so a pretty variation was costing the surface its guard. `precisionParam` is the shape to
  copy — the per-tool part is a SUFFIX, so the shared text stays a verbatim prefix of every variant.

Rules:
- A count of **returned rows** is `returnedCount`; a count of **everything that exists** is
  `totalCount`. Never `entityCount` for either. When a filter or limit applied, **both** are present
  — a total that appears only when truncation happened is not recoverable by the caller.
- A field whose meaning depends on the entity's layer/kind must either be renamed per meaning or
  carry the qualifier in the payload (e.g. `onScreen` + `onScreenBasis: 'viewport'|'size-only'`).
- Space matters: any transform-shaped value states `world` or `local` **in its name or its
  description**, and the description must match what the code writes.

## 3. Aim: by name, never by pixels

Unchanged from [enact.md](enact.md), restated as a rule: aim by `entity {guid|name|id}`, `selector`,
or a handle id — all resolved **server-side inside the call**, so they cannot go stale between
calls. Raw `{x,y}` is refused wherever a resolvable aim exists (`modoki_capture_gesture` is the one
legitimate exception: it *measures* a path).

- `guid` is the only address that always works; `id` is reassigned on every scene reload.
- A `name` matching several entities is **refused**, everywhere — live path, file path, and input
  aim alike. First-matching is never acceptable (this was measured: one of two `DUP_probe` entities
  moved, `{ok:true, changed:1}`).
- A 2D/3D aim requires `surface`, even when only one viewport currently has the entity, so a call
  cannot silently mean a different panel than intended.
- An entity aim reports the `surface` it resolved in, and `occlusionScope` so `occluded:false` is
  never over-read.
- **A resolvable aim that something COVERS is refused** (`OCCLUDED`), naming the cover, with
  `allowOccluded:true` as the escape hatch. The input would land on the covering element, so
  reporting `ok` for it is the §0 rank-1 false success. This binds `entity` and `selector` alike —
  they are the same category, both resolved server-side — and raw `{x,y}` is deliberately exempt:
  a coordinate is exactly what the caller asked for, and there is no named target to be covered
  *relative to*. One carve-out, because it is about delivery rather than aim: a held gesture's
  `move`/`up` is delivered to whatever captured the press, so occlusion at the destination cannot
  stop it and is not checked.
- **A refusal that may be TRANSIENT says so** (#261). An aim refusal can be true at the instant it
  is asked and gone a frame later, because the dock has just changed and the target has not reached
  its final position — the verdict is accurate and the advice ("dismiss what covers it") is useless.
  Every aim refusal, on all three paths (`entity`, `selector`, and the handle route), now checks
  whether the layout MOVED across one frame and appends a warning when it did — including the
  DID-NOT-RESOLVE refusals, which is the branch that actually reproduces: an unsettled panel reports
  a ZERO RECT, so the resolver refuses with "zero-size"/"no element" rather than with a cover, and
  a hint on the covered case alone would stay silent on the one transient that is easy to trigger. It is a **hint, not
  a retry**: the call still refuses and nothing is dispatched. Settle-and-retry was the option
  weighed and DECLINED, on measurement — a React commit settles in 0 frames, a FlexLayout tab
  reveal in 1, a tab add/remove in 0-1, and none produced a false cover (the unsettled state is a
  zero rect, i.e. a clean "cannot resolve"). A caller who re-aims at all has already waited longer
  than the layout needs, so what was missing was never the retry — it was being able to tell the
  two cases apart. Measured in [enact.md](enact.md) § "A refusal that may be TRANSIENT says so".
- **Any id-shaped argument is validated.** `parentGuid` is validated today while `parentId` is
  passed through raw, so a stale numeric id produces an orphan entity — parented to nothing,
  invisible in the Hierarchy — reported as success (S1 `create_entity`/`reparent_entity`/`prefab`).
- **Both addressing SHAPES are accepted, so the choice is not a guess.** Aimed-input tools nest
  (`entity:{guid|name|id}`) because they also take a selector or a raw point and the aim modes must
  stay distinguishable; the editor-op tools take a flat `guid`. That rule was written nowhere and
  held only loosely — `set_transform` nests without being an input tool, `play_clip` was flat while
  declaring `aim:'entity'` — and `qa/knowledge.md` records the mix-up as a recurring trap. Since
  2026-08-22 the singular-aim tools accept **either**, so one shape works across the surface.
  Sending BOTH is refused (`AMBIGUOUS`) rather than resolved by precedence: a caller who gave two
  addresses does not know which one the tool used, and picking for them is the §0 rank-1 class.
  The SET-shaped params (`guids`, `entityIds`, `get_scene_state`'s filters) are deliberately
  untouched — they take a set, not an aim, and a singular `entity` there would be a third shape
  rather than one fewer.
  ⚠️ **The flat-side alias takes `{guid|id}` only — no `name` — and is `.strict()`.** Both halves
  are load-bearing, and the first version of it had neither. The ops behind these tools resolve
  through `requireLiveId({id?, guid?})` and have no name resolver, so accepting a `name` advertises
  a capability that does not exist; and because a nested `z.object` is **not** strict just because
  its parent is, zod silently STRIPS the key, so `entity:{name:'Crate'}` arrives as `{}` and
  surfaces as *"entity ref matched no live entity — it may be stale"* — an unclear failure pointing
  at the wrong cause. That is §1's silent-key-strip one level down. Resolve the name with
  `modoki_get_scene_state` and pass the guid.

## 4. Method, and the C7 convention

**`GET` = "tell me this". `POST` = "do this".** This is not cosmetic: it decides whether the
response's `ok` field is checked.

- **POST** → `ok` is a **success flag**, so `postJson` runs `isFailureBody` and a 200 saying "I
  refused" becomes a failed tool call.
- **GET** → `ok` may be the **answer**. `modoki_diagnose` returns `ok:false` to mean *your scene is
  unhealthy*; `validate_scene` is the same shape. `getJson` therefore must **NOT** run
  `isFailureBody`. **Do not "fix" this by adding the check** — it would report every unhealthy scene
  as a failed call and break ~30 read tools to fix nothing.

Therefore:

> **No mutating operation is reachable by GET.**

Because such an operation's failure is structurally unchecked. Six tools reach a mutating op by GET:
`modoki_build`, `add_native_target`, `ota_publish`, and (found only by reading query params, not
routes) `modoki_journal`, `editor_journal` — which mutate via `?action=start` and `?clear=1` (F3) —
and **`modoki_hit_regions`**, whose `action:'show'|'hide'` flips the overlay through a GET-only
route. All six now run their `ok:false` through the failure check at the call site, so a refusal
cannot arrive as a success; the remaining violation is the METHOD, and the fix pattern below.

⚠️ **The re-runnable query is only as trustworthy as the field it filters on — this sentence used
to say otherwise, and the tool it was written about is what disproved it.** The query is
`mutating:true && method:'GET'`, minus the tools that genuinely split by method (`modoki_profiler`,
`modoki_watch`, `modoki_input_watch`, `modoki_project_settings`). `modoki_hit_regions` declared
`varies:'both'` on a route with exactly ONE arm, so the query silently excluded it — while the prose
above named it correctly. Every guard that filters on `!varies` was disarmed by that one untrue
word, and a refused `action:'show'` reached the agent as a SUCCESSFUL call for as long as the
declaration stood (fixed 2026-08-21).

The lesson is not "trust prose after all". It is that **a declared field must be OBSERVED before a
guard may rely on it** — the same rule §10 already applies to `method`/`route`/`op`. `varies` is now
observed too: `mcpToolContracts.test.ts` drives every action of every multi-action tool, records the
method and route each one really uses, and asserts the declaration matches, with a totality check so
a new multi-action tool cannot skip the table. Re-derive the list from the query, not from this
paragraph — but only because the query's inputs are now checked.

**The fix pattern, if you close one:** `modoki_profiler` (#166 P6) is the worked example — the read
actions stay GET, the state-changing ones move to POST on the same route, and a mutating action
arriving by GET gets a **405 naming the right method** rather than being served.

**Inventory the query params, not just the route and the method.** A scan of route methods was blind
to three of the six — the two journals and `hit_regions`.

Two more consequences:
- **A missing route must 404, not 200.** On the default backend (the Vite dev server) an absent
  `/api/*` GET returns **200 + `index.html`** via the SPA fallback, and `getJson` only fails on
  `status >= 400` — so a web page is returned as a successful answer, and the wrong-clone identity
  banner can never arm (V3). Every GET tool is exposed on that config.
- **A tool's method never depends on an argument.** `modoki_project_settings` is a GET for
  `action:'get'` and a POST that writes `project.config.json` for `action:'set'` — half read, half
  disk write, under one name (F10, §7).

## 5. The error envelope

**Every failure names what was attempted, why it failed, and what to do instead.** "It didn't work"
is a bug by definition. A refusal that lists the real options is the single highest-value thing this
surface produces, because it converts a dead end into the agent's next move.

Shape — `isError: true` plus:

```jsonc
{ "error": {
    "code": "AMBIGUOUS",          // from the closed set below
    "tool": "modoki_set_transform",
    "what": "…what was attempted, in the caller's terms",
    "why":  "…the actual cause",
    "got":  "…what was received, when that is the point",
    "expected": "…the shape/values that would work",
    "options": ["…the real choices, when there is a finite set"]
} }
```

Closed code set (extend deliberately, never ad hoc): `UNKNOWN_PARAM` · `AMBIGUOUS` · `NOT_FOUND` ·
`AMBIGUOUS_SURFACE` · `OCCLUDED` · `REFUSED_BY_OP` · `NO_RENDERER` · `TIMEOUT` · `TOO_LARGE` ·
`REQUIRES_SAVE` · `NOT_AVAILABLE_HERE` · `PARTIAL`.

Rules:
- **A refusal is not a transport failure.** A deliberate op refusal is a 400 that says so, never a
  504 — `load_scene`'s correct "you have unsaved live-world changes" once arrived as a gateway
  timeout, sending the reader after a wedge instead of calling `save_all`.
- **`PARTIAL` is a failure unless the tool documents partial success.** `save_all` returning flat
  `{ok:true}` when one asset's write failed is the shape this forbids. `/api/reimport` is the
  sanctioned exception and says so in its own description.
- **"Could not look" is never reported as "nothing is there."** `ota_status` currently maps every
  gcloud failure — expired auth, no network, bucket typo — onto `release:null, note:'No release.json
  published yet'`. An unreachable source is `NOT_AVAILABLE_HERE`, not an answer.
- **"I looked at a stale copy" is not "this is current"** — the READ half of the rule above (#889).
  A route that computes an answer from files on disk while the renderer holds newer unsaved versions
  must say so, in a TYPED field a guard can check for, not a warning string. It does not refuse: a
  read that refuses is worse than one that caveats, and §8 covers work that would be *omitted*, which
  a disclosed read does not omit. ⚠️ The field is ABSENT when clean — a disclosure present on every
  call is one readers learn to skip. Mechanism: `docs/mcp-persistence.md` § "Disk is not the source
  of truth while an editor is open".
- **A no-op is a failure when the caller asked for a change.** `changed:0`, or a write whose keys
  the loader ignores, is `REFUSED_BY_OP` with the real field names — not `{ok:true, changed:1}` (V1).
- **A STATE refusal is RETURNED with its code — it must never escape as a PLAIN throw** (#994;
  `OpRefusal`, below, is the coded throw the bridge returns for you). This is
  the emit-side half of "a refusal is not a transport failure" above, and without it that rule
  cannot be kept: an op that throws has no way to name its code, because every relay route turns a
  throw into a hard-coded **504** (a **500** on the Electron host), which the MCP client maps to
  `NOT_AVAILABLE_HERE` — *"could not look: the route is absent"*. So `render-scene`'s plain
  `Error('no scene renderer registered…')` told an agent to relaunch a perfectly healthy editor,
  and told `test:mcp:live` a live route was a DEFECT. **The op is
  the only layer that knows which failure this is**, so it returns `{ok:false, code, error,
  options}` and the route relays it (`opRefusal`/`refusalStatus` in `editorBackendRouter.ts`).
  **Or it throws `OpRefusal(code, message, {options})`** (`engine/app/debug/opRefusal.ts`, #1012):
  the form for a helper buried under many callers (`requireLiveId`, `guardUnsaved`), which
  `opReplyFor` turns into that same returned envelope. A plain `Error` is never a coded refusal.
  ⚠️ **The editor has TWO relay transports, and both call `opReplyFor`.** The HMR relay answers
  through `relayResponseFor`; the Electron IPC handler deliberately does not use it — IPC reaches
  exactly one `webContents`, so there is no broadcast and no decline to count (`main.ts`'s
  `requestRenderer` docblock) — so a conversion placed in only one of them is dead in
  the other — the packaged editor. **The device TCP relay is a third, and it does NOT carry a code:**
  `bridge.ts`'s `delegateToAgentOps` flattens any throw into the `Error: <msg>` string sentinel the
  game-debug MCP flags, so an `OpRefusal` thrown by a RUNTIME op would lose its code there. None is
  thrown by one today — every recoded site is an editor op, which never runs on a device — and
  making the device channel carry §5 codes is a protocol change to that MCP, not an extra call to
  `opReplyFor`. Four riders:
  - **The discriminator is a code from the CLOSED set**, not `ok:false`. Dozens of ops report a bad
    parameter as `{ok:false, reason}` at HTTP 200, where `isFailureBody` picks them up; only a
    named code is a claim to know which §5 failure this is, and only that claim earns a status.
  - **One code, one status.** `NO_RENDERER` → 503 everywhere; anything else the ops name is the op
    answering, which is a 400 (`relayFailureStatus`'s own argument). The CODE is what the agent
    reacts to — a body-supplied code beats the status-derived one (`codeFromBody`).
  - **Classify structurally, never by message prefix.** The Electron capture path throws a
    `CaptureUnavailableError` CLASS for exactly this reason; `relayFailureStatus`'s scar is what
    string-matching an error costs — a bare word in one op's prose eventually collides with
    another's.
  - **Recode a refusal only where the sharper code is TRUE** (#1012). Of the 67 plain throws in
    `agentEditorOps.ts`, about a dozen were: a stale entity or missing asset (`NOT_FOUND`), unsaved
    work (`REQUIRES_SAVE`), a save where something landed (`PARTIAL` — decided from the landed
    list, never from the prose), contradictory arguments (`AMBIGUOUS`). A missing parameter, a wrong
    asset kind, a no-op and an internal failure are honestly `REFUSED_BY_OP` and stay plain throws —
    and so does a loader whose `null` conflates *missing* with *malformed* (`getPrefabSource`),
    where `NOT_FOUND` would be a guess stated as a fact.
- ⚠️ **THE RELAY IS A BROADCAST, and it settles on the first AUTHORITATIVE reply — not the first
  reply** (#1030). `ws.send` reaches every HMR client, so `modoki:request` runs in every open tab,
  not only the editor's. A tab on the dev server's runtime route has no editor ops registered and
  used to REJECT in about a millisecond, beating the editor tab (which has to do the actual work)
  and settling the request on its behalf. Anything reading that rejection as *"no editor exists"*
  then got a false negative about a live editor holding state: `applyMovesInRenderer` maps
  `unknown agent op` to `{kind:'absent'}` and skipped the asset-path repair **silently** — no warn,
  no `repairFailed` — while the editor's bindings, parked writes and Inspector selection still
  keyed on the dead path (#186's symptom, reported as a clean move).

  **A decline is not an answer.** A client answers `{declined: true}` for an op it has no handler
  for (`relayResponseFor`, `agentBridge.ts`), and the registry COUNTS declines, rejecting only once
  every client has declined — at which point *"nothing out there has this op"* is true rather than
  merely first.
  - ⚠️ **The denominator is ANNOUNCED BRIDGE CLIENTS, not `ws.clients.size`.** Counting sockets
    made an ordinary case hang: `/@vite/client` connects while `index.html` is still parsing, but
    `initAgentBridge` is reached through a dynamic import several module-graph levels later — and
    never at all for a tab sitting on the Vite error overlay. Such a tab is counted-but-mute, its
    decline never arrives, and the request rides the CALLER's full budget instead of settling
    (1.5s on the move repair, which then warns about a live editor that was never at risk; 60s on
    `/api/eval`). A client is counted once it has sent a `modoki:schema` or a `modoki:response`;
    one that has announced nothing has also registered no ops, so excluding it can hide no answer.
  - ⚠️ **Declines are a SET of clients, not a tally.** `settle`'s contract is that a duplicate or
    late reply cannot double-settle, and on the decline path keeping that needs identity — Vite
    supplies it as the second argument to `ws.on`. Without it, two replies carrying one id from
    the SAME client reach the denominator and reject while the editor is still working, which is
    #1030 reinstated. `initAgentBridge` has no idempotency flag and `hot.on` appends without
    dedupe, so that pair is one stray double-registration away.
  - ⚠️ **`declined` and `error` are separate channels because they mean opposite things.** "I do
    not have this op" is countable; "this op threw" is a real answer from the one client that OWNS
    the op and must settle immediately. Collapsing them — which is what letting `runAgentOp` throw
    did — IS the defect, and collapsing them the other way turns every genuine failure into a
    stall.
  - ⚠️ **Membership is asked BEFORE dispatch**, never by catching `/unknown agent op/` out of the
    dispatch: a string test would miscount an op that legitimately throws those words, and would
    already have RUN the op before deciding whether it existed.
  - ⚠️ **The all-declined rejection carries the SAME `unknown agent op '<op>'` string**, and that
    is load-bearing. Three consumers in `editorBackendRouter` key off it and they disagree about
    what it MEANS on purpose — a repair's safe answer (`absent`) and a guard's safe answer
    (`unknown` → refuse) are opposites on that exact string. #1030 removes the race WITHOUT moving
    the string; a fix that "cleaned it up" would silently re-decide both.
  - The same string arriving as a plain `error` (a tab loaded before #1030) is counted as a decline
    too, **at the transport and nowhere else** — that is the only layer that knows the send was a
    broadcast. ⚠️ That test is **anchored** (`/^unknown agent op\b/i`) and gated on the reply
    carrying no `result`, unlike the three consumer-side tests. They ask *"is this message about an
    absent op?"*; this one asks *"is this reply a decline rather than an answer?"* and runs against
    every reply, so an unanchored version would miscount a real op whose own error contains the
    words — the precise miscount the client-side membership test exists to avoid.
  - **Bounds, both accepted:** a client that disconnects mid-flight never declines, so the request
    rides to its timeout instead of settling absent (honest, and every consumer already treats a
    timeout as ambiguous); and if a future Vite stops exposing `ws.clients` the intersection
    falls back to every client still in the announced set — which is bounded only because that set
    is PRUNED on `vite:client:disconnect`. ⚠️ Without the prune that fallback counts every client
    ever seen, and after a day of HMR full-reloads every relayed op would ride its full budget.
  - **Vite only.** Electron sends to its one renderer window and has no broadcast, so its relay
    reaches `agentBridge`'s dispatcher directly rather than through `relayResponseFor`. ⚠️ **Do not
    "make the two consistent"** — routing Electron through it would emit `declined` replies, and
    `main.ts` would resolve them as `undefined`, turning every unregistered op there from a
    `504 NOT_AVAILABLE_HERE` into a fabricated `200 {}` across ~30 relayed routes. That handler
    rejects on `declined` now, so the trap is closed from both ends, but the asymmetry is correct.

- **A relayed route never HARD-CODES its catch status** (#1013). This is the receive-side half of
  the rule above, and the two are not the same fix: the emit side stops an op from *losing* its
  code, this side stops the route from *inventing* one. `ctx.requestBrowser` rejects identically
  whether the relay died or the op threw, so a literal `504` in the catch reports every refusal the
  op raised as `NOT_AVAILABLE_HERE` — the editor declared unreachable while it is answering. Twenty-
  six routes did that; `relayJson` in `editorBackendRouter.ts` now states the recipe once, and a
  guard (`tests/plugins/relayRefusalStatus.test.ts`) fails on a new literal.
  - **The classifier is what PRESERVES the 504**, so adopting it costs a genuine transport failure
    nothing. The argument for leaving a route on a hard-coded 504 — *"a route SHOULD 504 on a real
    transport failure"* — is true and is an argument FOR `relayFailureStatus`, not against it.
  - ⚠️ **The accept side is the half to test.** `relayFailureStatus` decides by matching the
    message, and that list has been found incomplete three times. A change that made every relay
    error a 400 would pass every refusal test and be worse than the bug it replaced, so a
    genuinely-dead renderer must be pinned by signature, with the strings the host actually sends.
  - ⚠️ **`/api/eval` is the one route that must NOT read a returned envelope as a refusal.** The
    reply is the eval's own return value, so a body ending `return {ok:false, code:'NOT_FOUND'}` is
    agent DATA; it is wrapped in `{result: …}` so no envelope reaches the top level. Every other
    relayed route relays one. ⚠️ Three did not until #1012 — `/api/editor-action`, `/api/asset-def`
    and `/api/asset-meta` sent a bare `json(raw)`, i.e. the envelope as a **200**. `postJson`'s
    `isFailureBody` rescued the POST, but the two GET tools run no `checkFailure`, so a coded
    refusal there would have reached the agent as a SUCCESS.
  - ⚠️ **A route that post-processes its reply must check the envelope before it returns.** Only one
    of the six spreads unconditionally (`/api/editor-state`, which merges main-process facts into
    the relayed object) — there an envelope really would come back as a 200 whose body is a refusal
    wearing `persistenceMode`. `enact-handles` gates its decoration on `Array.isArray(handles)`,
    which an envelope cannot pass, so its bug was the STATUS alone. Worth separating: the
    reshaped-into-a-plausible-answer failure (§0's rank 1) and a merely wrong status are different
    severities, and an earlier draft of this bullet claimed the first for a route that only had the
    second.

## 6. Response budget: summary-first

Unchanged from [mcp-response-budget.md](mcp-response-budget.md), restated: a bare call returns
counts/an index; a filter buys detail; over the cap the response becomes a **valid JSON envelope**
that says what was elided and which filter to reach for — never a severed blob.

- Every large read declares its narrowing params in its contract, and the over-cap hint names them.
- A declared filter must be a real parameter of that tool (enforced) — a hint that names a
  nonexistent filter is a dead end that reads as the agent's mistake.
- Floats are rounded to 9 significant digits, so an edit is verified with a **tolerance**, never `===`.

## 7. One tool, one job

**A tool does one thing. A destructive mode never rides along with a read.**

> **A `read` tool never mutates.**

`read` is the promise Percept makes, and it is the one thing an agent must be able to do freely — a
read that mutates makes **verification itself destructive**. Today `modoki_journal` and
`modoki_editor_journal` are declared and documented as reads and can destroy the buffer they read
(`clear:true`), while `modoki_get_console_logs` does the same job and stays pure — so this is a
choice, not a necessity (F9).

Splitting rule: **if one argument value changes the tool's method, its route, or whether it writes to
disk, it is more than one tool.** Current offenders (F10): `project_settings` (get/set),
`watch` (start/read/list/clear, spanning both methods), `journal` (read + capture-window control).
`play_control`/`history` are acceptable — the op varies but the job does not.

`varies` / `opVaries` in the contract table is a **smell marker**, not a blessing. It exists so the
variance is machine-readable while it lasts.

## 8. Mutation semantics

- **Every agent mutation runs inside the actor lease.** An edit outside one is journaled as
  `source:'human'` — the tool lying about who acted, in the very record a human would consult.
- **One call = one undo entry**, so a human's Cmd-Z unwinds it as one step. (`modoki_batch` is N
  entries; that cost is knowingly accepted and documented.)
- **Persistence is manual and the response says so**: a live edit reports `saved:false` plus the
  hint naming `modoki_save_all`. A tool that writes the file reports `saved:true`. Never guess.
- **An operation that swaps the world, or READS OR WRITES a file the editor holds unsaved work
  for, refuses when that work would be lost or omitted**, with `REQUIRES_SAVE` and an escape hatch
  — `discardUnsaved` where the work is DESTROYED (`load_scene`/`new_scene`/`prefab edit-open`/
  `write_asset_meta`), `force` where it merely goes un-included (`build`/`add_native_target`/
  `ota_publish`/`reimport_asset`/`duplicate_asset`). Two consequences, two names: one word for both
  is how an agent carries a harmless habit into an irreversible one. `load_scene`/`new_scene`/
  `build` do this; **`ota_publish` does not** — it builds from the scene file and ships over the
  air, so an agent that just edited the live world publishes an artifact missing its own work and
  is told "✅ Published" (S1).

  ⚠️ **This said "world-swapping or file-READING", and the omission was load-bearing** (#872). A
  file WRITE is the case with the worst consequence — `write_asset_meta` replaces a `.meta.json`
  wholesale, destroying a parked Inspector edit — and the rule as written did not name it, so the
  issue that found the defect declared an open three-way contract fork and parked the work for a
  decision this section had already made. **Check this doc before drafting options**; a rule that
  covers your case is not always spelled with your case's verb.

  ⚠️ **"Unsaved work" is not only the live world.** Anything the editor is holding that disk does
  not have counts, including a registry in the RENDERER that the answering route runs too far from
  to see — the sidecar park gate has to make a round trip to ask, and "the renderer did not answer"
  must be a refusal, not a proceed (see §5, and `docs/mcp-persistence.md` § 5).
- **What can be proven wrong BEFORE starting is refused before starting; what is only discovered
  mid-flight is reported per-op.** A `setTrait` naming a field the trait does not have is provably
  ineffective from the schema alone, so `/api/scene-mutate` now refuses the whole call pre-flight —
  nothing applied, nothing written, on either the live or the file path. This replaced a
  half-and-half shape that applied the valid ops, wrote the junk field to disk, and *then* answered
  `ok:false`: a caller who reads `ok:false` reasonably assumes nothing happened, so a partial apply
  behind a failure verdict is worse than either honest outcome. An entity-not-found, by contrast,
  can only be learned while applying, so it stays a per-op error alongside whatever succeeded.
- **A write is verifiable.** For every authoring tool there is a read that returns what was written,
  from the same place the write landed (`read_asset_def` reads the LIVE cache, because an unsaved
  edit exists only there). A write whose effect cannot be read back cannot be verified without
  judging pixels, which this surface tells agents not to do.
- **A file write invalidates the cache the runtime reads.** A `.particle.json` write currently
  leaves the renderer's particle cache stale, so a read-back returns the pre-write def as live truth
  and a read→modify→write round-trip silently reverts the file (S1) — the bug already fixed for
  `.anim.json`, unfixed for particles.

## 9. Cross-surface parity

**These rules bind all three surfaces.** `device_*` and the `curl` API are not exempt, and the audit
found the predictable result of treating them as separate: the device server has **no
`isFailureBody` equivalent**, so a 200-with-`{ok:false}` is reported to the agent as success across
all six device Percept tools — the exact class fixed on the editor side and silently unfixed here.

- **A rule implemented twice diverges.** `result.ts` and `summarize.ts` exist in both MCP servers,
  diverged (136 vs 64 lines). Shared behaviour lives in ONE module both import (F5).
- **Per-surface state is keyed to its lease.** The device MCP caches `adbScreenInfo` in a module
  global that is never cleared when the lease changes, so a tap after switching devices is scaled by
  the *previous* device's dimensions and reports "Tapped (x,y) — ok" (S1).
- **A capability reachable on one surface and not another is a finding**, either closed or recorded
  as deliberate with a reason.

**Where an op is REGISTERED is what keeps parity closed — this is structural, not a habit** (#166).
The device surface and the editor surface differ in exactly one way: the device has no editor.
So:

> **An op whose implementation needs only `runtime/` registers in `agentBridge.ts`, where both
> surfaces get it. Only an op that touches editor chrome, the undo stack, or the project on disk
> belongs in `agentEditorOps.ts`.**

Both eval APIs are *generated from the op registry*, which is why `device_eval` could never have
substituted for the missing tools — eval adds composition and zero capability. Registering a
runtime-only op in the editor file is therefore not a stylistic slip; it is how the write gap
opened one op at a time, each new capability landing wherever its first caller happened to live.
An op registered in `agentEditorOps.ts` whose handler reaches nothing from `editor/` is a finding.

## 9-bis. A cross-runtime reply is DECODED, never cast (#644 → #647/#648)

Every reply that crosses a runtime boundary — the device wire, the `requestBrowser` relay, the
Capacitor bridge, an `/api/*` route answering a long-lived MCP process — comes from a producer that
**versions independently of its consumer**. A TypeScript annotation on that value is a promise
nobody keeps. Three defect shapes came out of casting one anyway, and all three report something
FALSE rather than failing:

| Shape | What the caller is told | Example |
|---|---|---|
| A named field is absent | a confident **empty answer** | `list_assets` on a missing route: "this project has no assets" (`.assets` on the SPA's `index.html`) |
| An array method on a non-array | throws into a `catch` that means something else | #644's `result.map is not a function` reported as *"no editor is listening on that port"* |
| A declared field is dropped | **could-not-look collapsed into nothing-is-there** | `getNativeLogs` dropping `error`, so `{logs:[], error:'OSLogStore denied'}` reads as "No logs." |

**The pattern**, established by `parseConsoleLogsReply` (`game-debug-mcp/src/reply.ts`) and
`decodeAimReply` (`plugins/backend/deviceAim.ts`), and now also `parseNativeLogsReply` and
`decodeSceneOpsReply` (`plugins/backend/sceneOpsReply.ts`):

1. A **pure decoder** — `unknown` in, a **discriminated union** out. Never a throw, never a cast.
2. **Every historical wire shape tolerated explicitly**, with the commit or build that changed it
   named in the comment. A bare array and `{logs, …}` are both live at once whenever the two sides
   ship separately.
3. An unrecognised shape is described **BY KEYS ONLY** — `describeShape` in
   `engine/tools/shared/mcpResult.ts` (the §9 shared home; `engine/app/debug/bridgeHelpers.ts`
   keeps a deliberate copy, because `engine/app` reaches `tools/shared` only with `import type` and
   a value import would put MCP formatting code in the bundle that ships to devices). A log line or
   a scene op can carry secrets and authored strings; a refusal must never echo the value.
4. The refusal says **what it is NOT**: "this is not 'the project has no assets', it is a reply this
   build cannot read."

⚠️ **Pick the remedy by whether the work already happened.** A relay that never returned is safe to
call "no editor" and safe to retry. A relay that RETURNED an unreadable shape is neither — the ops
already applied. `/api/scene-mutate` reported the second as a 500, which `context.ts` maps to
`NOT_AVAILABLE_HERE` ("relaunch the editor"), so a caller retried and **double-applied a write**. It
now answers 200 `{ok:false, code:'PARTIAL'}`: `isFailureBody` makes it a failure and `codeFromBody`
lifts the code, so `PARTIAL` reaches the agent with no new plumbing.

⚠️ **`raw call()` skips the shared guards.** `htmlFallthrough` runs inside `getJson`/`postJson`
only, so a raw-`call()` site gets no SPA-fallthrough protection — a missing dev-server route answers
**200 with `index.html`**. Raw `call()` is legitimate (a §5 label more specific than `getJson`
hardcodes; a shape guard that must not throw into `getJson`'s `transform`-then-catch), but such a
site must apply `ctx.htmlFallthrough`/`ctx.noSuchRoute` itself.

## 10. Every tool declares its contract, and is covered three ways

- **Contract**: one entry in `contracts.ts`, asserted both directions (no tool without a contract,
  no contract without a tool). `method`/`route`/`op`/`varies`/`undoable`/`minimalArgsMutates` are
  declared **and verified against observation** — a declaration alone can lie, which is how a tool
  ends up documented but dead.
  ⚠️ **A field a guard FILTERS on must be observed before the guard can be trusted.** The table
  splits into an observed half and a declared-only half, and every drift the 2026-08-21 audit found
  lived in the declared-only half — because a wrong declaration there does not merely mislead a
  reader, it *disarms the check*. `varies` was declared `'both'` on a single-arm route and silently
  exempted `modoki_hit_regions` from all three mutating-GET guards; `undoable` was `false` on five
  tools whose ops push an undo entry, so the generated catalog stated the opposite of the truth;
  `minimalArgsMutates` decides what the live sweep fires at the human's open editor and was only
  ever checked against itself. All three are observed now. The ones still declared-only —
  `mutating`, `persists`, `requires`, `aim`, `filters` — are cross-checked against each other but
  not against behaviour, so treat a guard that filters on one as provisional until it is.
- **Coverage** — a tool is not "covered" until all three exist. Each tier can prove something the
  others structurally cannot, which is why none of them substitutes for another:
  1. **T1 unit** (`engine/tests/tools/mcpRegistry`, `mcpToolContracts`) — the tool exists, its schema
     is strict *as registered*, every param is documented, its contract matches the request it makes.
     Cannot prove the route on the other end is real.
  2. **T2 integration** (`mcpSurface.ts` / `deviceSurface.ts` + `liveCoverage.test.ts`,
     `deviceToolCoverage.test.ts`) — every tool called through its REAL handler against a stub
     backend: the request it makes, a 500 → a `§5` envelope naming the tool, a `200 {ok:false}` → a
     failed call. Table-driven over the registry, so it cannot miss a tool. Cannot prove the route
     exists either — the stub answers whatever the test wants.
  3. **T3 live** (`npm run test:mcp:live`) — the sweep calls every NON-mutating tool in its
     **ergonomic form** (`minimalArgs`, every default taken) against a running editor;
     `test-smoke.mjs` drives the mutating ones through create → verify → clean up. The only tier that
     can catch a dead tool.
- **T3 is not optional, and it is CLAUDE'S job to run it.** `modoki_prefab` 400'd on *every* call for
  months with T1 and T2 green. The repo owner does not drive MCP tools — the surface exists for the
  agent — so "someone will notice" is not a safety net. Run it after any change to
  `engine/tools/**`, an `/api/*` route, or an agent op.
- **What T3 cannot reach is DECLARED, not implied.** A sweep must not damage the human's open project,
  so ~39 mutating tools (`build`, `press_key`, `menu`, `eval`, …) are listed in
  `src/liveCoverage.ts` with the reason each is un-sweepable, and a CI-safe guard asserts the split
  stays total: every tool is swept, smoke-covered, or listed. A gap list nothing checks is a gap list
  that grows.
- **A `COVERED_BY_SMOKE` entry is a CLAIM, and the guard that keeps it honest is TEXT-based** (#496).
  `liveCoverage.test.ts` asserts every listed name appears in `test-smoke.mjs` — that proves the name
  is present, not that anything runs it. Necessary, not sufficient: three entries
  (`modoki_dispatch_action`, `modoki_set_selection`, `modoki_save_all`) passed that grep with no
  executing case behind them. Watch for two shapes: a name inside a batch step the case asserts is
  REFUSED before it runs, and a name in an assertion that the step landed in `notRun` — a case that
  PROVES the tool did not run still satisfies a grep for it. Only a human reading the call site
  distinguishes these; the guard stops the debt growing, it cannot audit what is already claimed.
  Adding a name to the bucket silences the sweep and buys nothing.
- **A live smoke case that SAVES must leave the working tree clean** (#496) — it runs against the
  human's real project (CLAUDE.md #18). ⚠️ Passing an explicit `path` does not make it safe, two ways,
  both measured. (a) A save-as writes the CURRENT scene's own guid into the new file, so the probe and
  the real scene briefly share one guid; the dev asset scanner auto-heals a guid collision by keeping
  the lexicographically-first path's id and REWRITING the other file
  (`engine/plugins/vite-asset-scanner.ts`, `buildManifest(..., heal=true)`) — the first green run of
  the save_all case re-minted the guid of the committed `tropical-island.scene.json` while reporting
  SMOKE OK. Keep the probe out of the manifest entirely: `detectType` classifies a plain `.json` as a
  scene only by the `.scene.json` suffix or the legacy `/scenes/` directory, and as a material only
  under `/materials/` — anywhere else it is not an asset at all, so it carries no guid to collide.
  (b) `path` redirects only the PRIMARY scene — `saveAll`'s `extraSaved` loop
  (`engine/packages/modoki/src/editor/scene/serialize.ts`) writes every other dirty loaded scene to
  its own real path, which no argument redirects and no precondition can see. A case that saves must
  inspect `extraSaved` and fail loudly naming those files. General rule: verify a smoke case with
  `git status` after the run, not its own ✓.
- **A refusal the sweep expects is declared too** (`EXPECTED_REFUSALS`, matched on the refusal text
  with the reason it is correct). Without that, the sweep either flags three correct refusals every
  run — and gets ignored — or blanket-accepts `REFUSED_BY_OP` and stops seeing a real one. A stale
  expectation that no longer fires also fails the run.
- **Every backend ROUTE is tool-reachable, or declared as not-for-the-agent.** The same
  totality discipline one level up from the coverage ledger: `routeCoverage.test.ts` asserts each
  `/api/*` route either has a `modoki_*` tool, or an entry in `NO_TOOL_BY_DESIGN` **with the reason
  the agent loses nothing**, or one in `AGENT_GAPS`. The two buckets stay separate on purpose —
  collapsing a gap into "by design" is exactly how it becomes a permanent exemption, so a route with
  no tool has somewhere honest to go and the next one cannot quietly be filed as intentional.
  Keep `AGENT_GAPS` even when it is empty, for that reason. It runs in reverse too: a contract route
  no router defines is a DEAD TOOL, which is the `modoki_prefab`-400ing-for-months failure.
  It was worth building — 41 of 104 routes had no tool, and six of those turned out to be
  capabilities we meant to expose, two of them documented as existing *for the agent*.
- **Docs are generated from the contract** where they can be — the tool catalog in
  `docs/debug-tools-mcp.md` is rendered by `src/toolCatalog.ts` and guarded by
  `toolCatalogSync.test.ts`, so a drifted doc is a red build rather than a discovery. The guard
  compares against the same render function the generator writes with; comparing against a second
  implementation of the table would reintroduce the drift it exists to prevent (§9).

### 10a. The size budget is a gate; the ledger beside it is data (#894)

`DEFINITION_BYTES` in `engine/tests/tools/mcpRegistry.test.ts` pins the total byte size of the whole
advertised surface — every description plus every schema, property NAMES included — with a
4,000-byte headroom. **It is a real product cost, not bookkeeping:** `engine/electron/connectClaude.ts`
writes this server into the user's `.mcp.json`, so everyone who connects Claude Code to a packaged
editor pays those ~153 KB in their context window every session, before asking for anything. Growth
should be spent deliberately, and the pin is what forces someone to decide.

**What the pin cannot do is say whose bytes they were.** It is one scalar, and six clones add tool
prose concurrently: each stays inside the headroom alone, so each is green, and whoever crosses first
inherits the whole accumulated gap. `61fccae48` is the pure case — a re-pin after a four-branch
merge in which no tool changed at all.

So attribution lives beside it as **data that never votes**:

| | |
|---|---|
| written by | `npm --prefix engine/tools/modoki-mcp run gen:ledger`, **unconditionally** from `/close-out` § 6 |
| lands in | `engine/tools/modoki-mcp/ledger/<branch>.csv`, committed |
| grain | one row per tool whose size CHANGED — a quiet run appends nothing |
| columns | `date, clone, tool, delta_bytes, tool_bytes_after, surface_bytes_after, sha` |
| query | `sqlite3 :memory: '.import --csv engine/tools/modoki-mcp/ledger/work-ai3.csv l' '…'` |

Three things about it are load-bearing:

- **It changes no verdict.** `verify` and the free 3-OS public CI compute the same red/green from the
  same committed pin as before. An earlier sketch put the counter in a machine-local file under
  `~/.modoki/` and was rejected for making the GATE non-reproducible — CI has no such file, a fresh
  clone has no such file, and the Windows clone cannot share the Mac's.
- **One CSV per clone, never one shared file.** Six writers appending to one file conflict on every
  merge; six files never do, and the sum is a glob.
- ⚠️ **Run it unconditionally, not "when you touched the surface".** Skipping the step does not skip
  the bytes, it defers them onto whoever runs it next: a clone that merges `origin/main` and skips,
  then later edits one description, records the whole merged delta against its own sha that day.
  A quiet run appends nothing.
- ⚠️ **The writer REFUSES to run against an uncommitted tool surface**, and the reason is a real
  incident rather than a precaution. `/close-out` § 2 spawns an `opus-reviewer`; reviewers
  mutation-test by editing the tree; § 6 then runs the writer unconditionally. On 2026-09-11 those
  overlapped during this ledger's own close-out and it recorded **105 phantom rows** (+1 B on every
  tool, "surface now 153065") into the committed CSV — silently wrong, and authoritative-looking,
  which is the one thing the ledger must never be. Reverted by hand; the guard now makes it
  impossible. A clean tree at that point is what the workflow already guarantees (CLAUDE.md: commit
  before the gate), so it refuses only where the number would be a lie.
- ⚠️ **INTEGRATION branches keep no ledger.** `ledgerSkipReason` refuses on `main` **and on
  `release_*`** — a release branch is the HUB under another name (CLAUDE.md § Dev Workflow: the hub
  cuts it and merges it back), so its rows would be the same union `main`'s would be, and the
  never-delete rule would keep the file visible forever. An earlier version of this guard argued
  `release_*` was a worker concern and left it open; that had the workflow backwards.
  `MODOKI_LEDGER_CLONE` overrides both, so this is a default rather than a prohibition.
- ⚠️ **It is keyed by BRANCH, not by clone directory** — the filename comes from
  `git branch --show-current`, and the two coincide only because each clone stays on its own
  long-lived branch (CLAUDE.md § Clones).
- ⚠️ **The decision is a pure function with a test, not an `if` in the script**, and that is not
  ceremony: the branch is unreachable from any clone that could exercise it (a worker cannot be on
  `main`; its only lever *disables* the check), so a typo like `'Main'` would be invisible to
  `verify`, to CI and to every worker, and would first execute on the hub — once — seeding the file
  it exists to prevent.
- ⚠️ **A row is not authorship.** It says *this tool measured N bytes on this clone on this date,
  having moved D since this clone last looked*. A worker merges `origin/main` before pushing, so an
  observed delta may be work that arrived from another clone entirely. `sha` is what turns an
  interesting row into an answer; the ledger's job is to make you read four rows instead of an
  anonymous 4 KB.

⚠️ **The measurement is shared, and must stay shared.**
`engine/tools/modoki-mcp/surfaceBytes.ts` owns the walk; both the pin test and the ledger script call
it. **Do not build a second walker on `dump-surface.mjs`** — that one is per-tool too, but its
`sumDescriptionBytes` deliberately EXCLUDES property names because it prices documentation prose,
where the budget prices the whole advertised surface. Rows built on it would look authoritative and
quietly fail to sum to the number they exist to explain. Same reasoning as the catalog generator
sharing `renderCatalog()` with its guard (§9).

⚠️ **What the guard test can and cannot do — measured, and previously documented wrongly in BOTH
directions.** `mcpRegistry.test.ts`'s *"the ledger prices the surface identically to the gate, tool
for tool"* **does** catch a divergent enumeration *and* a divergent pricing function: a ledger priced
1 B/tool differently, with identical tool names, is red there while `DEFINITION_BYTES` stays green.
That makes it the only guard against the `dump-surface.mjs` trap above, so its per-tool loop is
load-bearing and must not be trimmed as redundant. What it **cannot** catch is a walk that is wrong
the same way on both sides — both call one `toolBytes` in one process — so inflating `toolBytes` by
100 B/tool reddens the pin and leaves it green. Walk correctness belongs to the `sumSchemaBytes walk`
block (dropping `key.length` from its `properties` branch reddens 6 of those cases; the
`patternProperties` branch is a separate occurrence and reddens 1).

There is **no zod v3/v4 skew to worry about**, and an earlier draft of this section wrongly claimed
there was one held in check by that test. `surfaceBytes.ts` lives **inside**
`engine/tools/modoki-mcp/`, so a bare `zod` specifier resolves to that package's nested v3 under Vite
and Node alike — a structural guarantee from `node_modules` nesting, not a tested one. Measured both
ways at **105 tools / 152,960 B**. (The hoisted-v4 hazard the import comment in `mcpRegistry.test.ts`
warns about is real for files under `engine/tests/**`, which is why those import zod by explicit
path — it just does not reach a file inside the package.)

## 11. Writing a description

The description is the tool's contract with the agent — it is read far more often than this file.

- **Every parameter is documented**, in its own `.describe()` or the description text — an
  undocumented param is one an agent ignores or guesses at. This started as F1 (25 undocumented params
  across 21 tools) and is now a guard in `mcpRegistry.test.ts`, so the count cannot creep back up.
- **A documented default matches the code.** A wrong default is worse than none.
- **Say what the tool does NOT do**, when that is the trap: `render_scene`/`render_sequence` FORCE a
  render and therefore mask render-on-demand and stale-frame bugs — a caller debugging exactly that
  class needs to know the instrument heals the symptom.
  ⚠️ This bullet named **`capture_viewport`**, which is the tool that does the OPPOSITE: it is
  `webContents.capturePage()`, a screenshot of whatever each surface last drew, so it is the one
  capture that CAN hand back a stale frame. Corrected against [rendering.md](rendering.md)
  § "The measurement protocol" (measured 2026-08-18: three successive captures byte-identical
  through a real material change until a camera move re-armed the SceneView's dirty gate). Being
  wrong *here* is the expensive kind — this is the rule's worked example, so it taught the
  inversion to every reader learning the rule from it, and the same sentence is still copied
  verbatim across ~10 `qa/cases/**` (filed as a class, not patched here).
- **Name the verification.** A mutating tool's description names the read that confirms it.

## Decisions taken (the surface changes these rules implied)

These three needed owner sign-off because each changes the advertised surface. All three are DONE.

1. **§1 strict everywhere — LANDED.** An unknown key is now an error naming the real params, at the
   single registration point (`registerAll.ts`), so it covers direct calls and every `modoki_batch`
   step. It was the fix for a measured destructive bug: `modoki_set_selection {name:'Capsule'}` — no
   such param — parsed to `{}`, which that tool documents as "no refs = clear", so it CLEARED the
   human's selection and reported ok.
2. **§5 error envelope — LANDED.** Every failure is `{error:{code,tool,what,why,got?,expected?,
   options?}}` from a closed code set, with the tool name stamped in centrally. There is no free-text
   failure constructor left to reach for.
3. **§7 splitting — DECIDED AGAINST, for `watch` and the journals.** Instead of splitting the tool
   names (a breaking change to every existing call), the *cross-action* hazard was closed where it
   actually bit: a read-time filter passed to `watch action:'start'` is REFUSED naming the right
   param rather than silently dropped (S3.19, which was widening a scoped watch to every entity with
   the component), and the mutating GETs (`?action=`/`?clear=`) now run their `ok:false` through the
   failure check so a refusal cannot arrive as a success. `project_settings` keeps one name because
   its `action:'set'` is already a different method on the wire and is declared as `varies`.

4. **§3 occlusion refusal on the SELECTOR path — LANDED (2026-08-19).** `entity` aims had refused
   since 2026-08-02 (`609663e75`; 2026-07-29 added entity ADDRESSING, not the refusal) and the
   DEVICE surface refused a covered selector from the start
   (`device_tap`: *"an OCCLUDED target is refused here rather than tapping something else"*), while
   the editor's selector path pressed anyway and reported `ok:true` with `occluded:true` in a
   field — §9's "a rule implemented twice diverges", and a rank-1 false success on the ranking in
   §0. It reached `modoki_tap`/`hover`/`scroll`/`pointer:'down'` and both `drag` endpoints; the
   handle aims (`tap_handle`/`drag_handle`) were closed in the same pass. The trigger was a
   measured one: a 2D gizmo handle sitting under the SceneView's own toolbar was pressed INTO the
   toolbar, answered `ok:true`, and was filed as a high-severity "the handle is completely inert"
   bug — the handle was fine. Backwards compatibility does not outrank #1, which is what made this
   a fix rather than a trade.

   Residual, recorded rather than churned: `device_hover`/`device_scroll` accept a selector but do
   not document the refusal their `device_tap`/`device_drag`/`device_pointer` siblings do. Closing
   it belongs in the shared `resolve-dom-point` op (§9's registration rule), not in a second
   per-route check.

The remaining known asymmetries are recorded rather than churned: the device↔editor NAMING
differences (`device_console_logs` vs `modoki_get_console_logs`, …) are tabulated in
`docs/debug-tools-mcp.md`, and the two genuine device gaps (`device_type_text`, `device_pointer`) are
features rather than convention violations.
