# MCP tool conventions

**Normative.** These are the rules every Modoki agent tool obeys — the `modoki_*` MCP (77 tools),
the `device_*` MCP (20), and the dev-server `curl` API. One rule per subsection, each with the
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
— verified at `@modelcontextprotocol/sdk/.../zod-compat.js:14`. For a tool whose params are all
optional, that turns a typo into **a different operation**: `modoki_set_selection {name:'Capsule'}`
(no such param) parses to `{}`, which that tool documents as "no refs = clear", so it **clears the
human's selection and reports success**. That was measured, fixed for `modoki_batch`'s pre-flight —
and left in place for every direct call, which is where most calls happen (V2).

Corollaries:
- `modoki_batch`'s envelope itself is strict too, including **inside** each step object: `arg` for
  `args` currently runs the step with no arguments (S1.batch).
- A tool with all-optional params and a destructive interpretation of `{}` is a hazard by
  construction (§7).

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
- **`position`** — documented as "World position" on `set_transform` while writing `Transform.x/y/z`,
  which is **local**. Every parented entity silently lands somewhere else, reported as success (S1).

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
- **Any id-shaped argument is validated.** `parentGuid` is validated today while `parentId` is
  passed through raw, so a stale numeric id produces an orphan entity — parented to nothing,
  invisible in the Hierarchy — reported as success (S1 `create_entity`/`reparent_entity`/`prefab`).

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

Because such an operation's failure is structurally unchecked. **Six** tools violate this today —
`modoki_build`, `add_native_target`, `ota_publish`, and (found only by reading query params, not
routes) `modoki_journal`, `editor_journal` — which mutate via `?action=start` and `?clear=1` (F3) —
and **`modoki_hit_regions`**, whose `action:'show'|'hide'` flips the overlay through a GET-only
route (`setHitRegionOverlayVisible`, `agentBridge.ts:1011`; the route has exactly one branch,
`editorBackendRouter.ts:1050`). A failed clear of the 10,000-event ring reports success.

⚠️ `hit_regions` was added AFTER the audit that produced this list, and the list said "five" until
the #166 close-out re-derived it from the contract table instead of re-reading this sentence. **A
count in prose goes stale silently; the re-runnable query does not** — every violator is
`mutating:true && method:'GET'` in `contracts.ts`, minus the ones that genuinely split by method
(`modoki_profiler`, `modoki_watch`, `modoki_input_watch`, `modoki_project_settings`).

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
- **A no-op is a failure when the caller asked for a change.** `changed:0`, or a write whose keys
  the loader ignores, is `REFUSED_BY_OP` with the real field names — not `{ok:true, changed:1}` (V1).

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
- **A world-swapping or file-reading operation refuses when unsaved live work would be lost or
  omitted**, with `REQUIRES_SAVE` and a `force` escape hatch. `load_scene`/`new_scene`/`build` do
  this; **`ota_publish` does not** — it builds from the scene file and ships over the air, so an
  agent that just edited the live world publishes an artifact missing its own work and is told
  "✅ Published" (S1).
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

## 10. Every tool declares its contract, and is covered three ways

- **Contract**: one entry in `contracts.ts`, asserted both directions (no tool without a contract,
  no contract without a tool). `method`/`route`/`op` are declared **and verified against
  observation** — a declaration alone can lie, which is how a tool ends up documented but dead.
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
- **A refusal the sweep expects is declared too** (`EXPECTED_REFUSALS`, matched on the refusal text
  with the reason it is correct). Without that, the sweep either flags three correct refusals every
  run — and gets ignored — or blanket-accepts `REFUSED_BY_OP` and stops seeing a real one. A stale
  expectation that no longer fires also fails the run.
- **Docs are generated from the contract** where they can be — the tool catalog in
  `docs/debug-tools-mcp.md` is rendered by `src/toolCatalog.ts` and guarded by
  `toolCatalogSync.test.ts`, so a drifted doc is a red build rather than a discovery. The guard
  compares against the same render function the generator writes with; comparing against a second
  implementation of the table would reintroduce the drift it exists to prevent (§9).

## 11. Writing a description

The description is the tool's contract with the agent — it is read far more often than this file.

- **Every parameter is documented**, in its own `.describe()` or the description text — an
  undocumented param is one an agent ignores or guesses at. This started as F1 (25 undocumented params
  across 21 tools) and is now a guard in `mcpRegistry.test.ts`, so the count cannot creep back up.
- **A documented default matches the code.** A wrong default is worse than none.
- **Say what the tool does NOT do**, when that is the trap: `capture_viewport` FORCES a render and
  therefore masks render-on-demand and stale-frame bugs — a caller debugging exactly that class
  needs to know the instrument heals the symptom.
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

The remaining known asymmetries are recorded rather than churned: the device↔editor NAMING
differences (`device_console_logs` vs `modoki_get_console_logs`, …) are tabulated in
`docs/debug-tools-mcp.md`, and the two genuine device gaps (`device_type_text`, `device_pointer`) are
features rather than convention violations.
