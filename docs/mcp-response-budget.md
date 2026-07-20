# MCP Response Budget — Percept/Enact Payload Sizing

This is the single deep reference for how the Modoki MCP surface keeps its responses
**affordable** for an agent: compact JSON, summary-first defaults, boundary summarization, and
token-not-character accounting. Percept made the editor readable; this design makes it callable
dozens of times per session without draining the context window.

The core insight: a tool that returns 40k tokens is one an agent calls once; a tool that returns
2k is one it can call forty times and actually converge. Response size is not an optimization — it
is the difference between an agent that iterates and one that runs out of context mid-task. Before
this work, one routine "did my edit land?" round — a default `modoki_get_scene_state` plus a
default `modoki_get_layout_bounds` — cost **~114,000 tokens** on a 135-entity project, plus a
hidden ~10k-token tax on **every single scene edit** that nothing read. That same round is now
**~3,000 tokens**, and a scene edit is ~50.

## How the numbers were measured (and a correction that matters)

Every token figure that shaped this design was originally computed as `characters / 4`. That proxy
is wrong in a direction that matters: checked against a real BPE tokenizer (`cl100k_base` —
OpenAI's, not Claude's, but the same class and the same digit/hex behavior), `chars/4`
**under-reports these JSON payloads by 25–38%**:

| payload | chars | `chars/4` | real tokens | error |
|---|---|---|---|---|
| `get_scene_state` bare index (135 entities) | 23,793 | 5,948 | **8,178** | −27% |
| `get_scene_state?trait=Transform` | 36,224 | 9,056 | **14,601** | −38% |
| `list_assets` full dump (pretty, pre-compaction) | 68,349 | 17,087 | **22,866** | −25% |
| `list_traits` full dump (pretty, pre-compaction) | 43,435 | 10,858 | 10,543 | +3% |

The payloads are **worse** than a chars/4 estimate implies and the savings **larger** in absolute
tokens; the ratios roughly survive, the absolutes do not. Any "tok" figure below sourced from the
original sizing is a chars/4 estimate unless flagged as measured.

**The proxy also mis-ranks the fields**, which is easy to get backwards. Trait names are
English-ish words that tokenize efficiently; hex GUIDs fragment at ~1.80 chars/token. In the bare
index:

| field | share by characters | share by **tokens** |
|---|---|---|
| `guid` | 26% | **43%** |
| `traits` | **43%** | 26% |

Exactly inverted. Consequences that are load-bearing when reasoning about further compaction:

- **A fixed hex prefix on the GUID would save more tokens (25–29%) than trait-set interning (24%)** —
  the opposite of the char-based ranking. Neither is implemented (see *Open / deferred*).
- **Base62 is the WRONG encoding for an LLM-facing payload.** It packs more entropy per *character*
  and less per *token*: a 17-char base62 id costs **16 tokens**, a 12-char hex id costs **6**.
  Measured: uuid-36 → 20 tok (1.80 chars/tok); hex-12 → 6 tok (2.00); base62-17 → 16 tok (1.06);
  base62-11 → 11 tok (1.00). Tokens are what we pay, so hex or lowercase beats a dense alphabet.

### Float precision — rounded to 9 significant digits

Agent-facing float fields are rounded to **9 significant digits**, which removes digits nobody can
use. Measured live: `trait=Transform` −18%, `world=1` −21%, `bounds=1` −21%, `layout-bounds` rects
−21% — **22,599 tokens** saved across the drill-downs; the bare index is unaffected (no floats).
Max absolute error is **3.5e-7** (`247.13061935179246` → `247.130619`).

- **Why 9, not 6.** The curve is steep at the wrong end: 6 sig-digits buys ~6 more points of saving
  but costs **1,400× the error** (3.5e-7 → 5.0e-4) and mangles clean authored values (`679.0625` →
  `679.062`). 9 keeps 73% of the benefit below any tolerance a renderer or physics engine cares about.
- **Why significant digits, not decimals.** `toFixed(3)` flattens `1.5e-7` and `0.0004321` to `0.0`.
  A scale of 1.5e-7 collapsing to zero is a bug report, not a rounding artifact.
- **It is lossy — verify an edit with a tolerance, not `===`.** `precision=0` returns exact float64.
  Rounding is applied at the agent OPS boundary (`app/debug/roundFloats.ts`), **never in the
  producers** — the editor's Inspector, gizmos and Sparkline read those in-process and keep full
  precision.

## The architectural rule everything turns on

> **Shape the payload at the BOUNDARY (the MCP tool / HTTP route), never in the shared PRODUCER.**

The producers — `computeLayoutBounds()`, `readWatch()`, `journalEvents()`, `readEditorJournal()`,
`computeHandles()`, `dumpSceneState()` — are **not** private to the agent surface. The editor's own
Debug Menu UI and diagnostics consume them, at full fidelity, in-process:

- `engine/app/debug/diagnose.ts:72` calls `computeLayoutBounds()` with no params and reads
  `.offScreen`. A counts-only *producer* would make `offScreen` undefined → `.length` throws →
  `engine/tests/framework/diagnose.test.ts` goes red and `modoki_diagnose` breaks in the field.
- `engine/app/debug/WatchTab.tsx:71,89` calls `readWatch(id)` with no flags and renders
  `s.samples.map(x => x.value)` into a `Sparkline`. A stats-only *producer* would blank the human's
  sparkline.
- `JournalTab.tsx:27-29` calls `journalEvents()` and tail-slices it itself.
- `engine/tests/electron/handlesDump.test.ts` and `engine/packages/modoki/tests/runtime/journal.test.ts`
  assert on full producer output.

So summarization lives in the route handler / MCP tool, where the *agent's* budget is the concern,
and the producer keeps returning everything to the humans and in-editor UI that need it. Concretely:
`computeLayoutBounds()` keeps its signature; `GET /api/layout-bounds` decides what to serialize. The
one architectural failure mode is summarization leaking into a producer — it will not announce
itself as a test failure until an editor panel goes blank.

A corollary, learned adversarially:

> **A byte cap must never mid-slice JSON.** `engine/tools/modoki-mcp/test-smoke.mjs:28` does
> `JSON.parse(text(state))` on a `get_scene_state` result, and the model (the real consumer) parses
> the text too. A naive `text.slice(0, 60_000)` yields unparseable garbage. When a payload exceeds
> the cap, the system returns a **valid JSON envelope** describing the elision, never a truncated
> blob.

## The compaction choke point — `result.ts`

The single highest-leverage mechanism is one function applied to all 67 tools' output, with no shape
change. Result formatting lives in `engine/tools/modoki-mcp/src/result.ts` — a pure, importable
module with no MCP-SDK dependency, so it is unit-testable
(`engine/tests/tools/mcpResult.test.ts`); `index.ts` keeps the 67 `server.tool(...)` registrations
and imports the formatter.

```ts
// engine/tools/modoki-mcp/src/result.ts
const MAX_PAYLOAD_CHARS = 60_000;   // ~15k tokens

/** Never mid-slice JSON: over the cap we return a VALID envelope describing the elision,
 *  because the consumer (the model, and test-smoke.mjs) parses this text. */
function encode(data: unknown): string {
  if (typeof data === 'string') return data;
  const text = JSON.stringify(data);            // compact, not (data, null, 2)
  if (text.length <= MAX_PAYLOAD_CHARS) return text;
  return JSON.stringify({
    elided: true,
    bytes: text.length,
    hint: `Response was ${text.length} chars (cap ${MAX_PAYLOAD_CHARS}). Narrow it: ` +
          `pass a filter (trait=/id=/name=/where=/layer=/ids=) or limit=N, or call without ` +
          `full=1. See the tool description for this tool's filters.`,
    preview: summarize(data),                   // counts + top-level keys, never the payload
  });
}
```

Load-bearing details:

- **Compact JSON everywhere.** `ok()` no longer does `JSON.stringify(data, null, 2)`. The indent was
  pure overhead — MCP ships `content[].text` opaquely and the model reads compact JSON identically.
  Pretty-printing cost 48% of `layout-bounds`, 38% of `scene-state`, 25% of `scan-assets`, across
  all 67 tools.
- **The identity `banner()` is prepended OUTSIDE the capped payload.** The "you are driving the
  sibling clone's editor" warning must never be the thing that gets truncated.
- **`err()` bodies are capped too** — a backend 500 that echoes a scene or a stack was unbounded.
- **`summarize()` is deliberately dumb**: `{key: <count or type>}` for each top-level key, so an
  elided response still tells the agent *what it would have gotten*.
- **The cap can fire on the routine path and that is correct.** Compact `scene-state` is still
  99,570 chars and `layout-bounds` 153,455 — both over 60k — but with the summary-first defaults
  below, the untargeted calls never reach the raw dump. The cap is not raised to accommodate the
  full dumps; the fix is the defaults.

`test-smoke.mjs` (the one existing end-to-end check) is wired to `npm run smoke:mcp`. It requires a
running editor, so it stays **out** of `npm run verify` / CI, but is runnable by name.

## Summary-first defaults, per tool

Each heavy tool defaults to a summary (counts / names / index) and returns full data only when a
query narrows it. Any **targeted** query returns values; only the untargeted sweep is an index.

### `get_scene_state` — names-only index by default

Default (no `full` / `trait` / `id`) returns entity identity plus trait *names*, no field values,
with a default `limit` and a `hint`:

```jsonc
{
  "scenePath": "…/tropical-island.json",
  "entityCount": 135,
  "truncated": false,
  "entities": [
    { "id": 12, "guid": "…", "name": "Island", "parentId": null, "layer": "3d",
      "traits": ["Transform", "Renderable3D", "ModelSource"] }
  ],
  "hint": "Names-only index. Drill down: full=1 (all field values), trait=Transform, id=N, name=<substr>, where=\"Transform.y > 3\", limit=N."
}
```

Measured **~40,123 → 5,938 tokens**. The 135 × (36-char GUID + trait-name array) dominates, which is
why it isn't smaller. `full=1` / `trait=` / `id=` / `name=` / `where=` return the curated dump with
field values — they are all in the producer's `targeted` set (`agentBridge.ts:260`), so any targeted
query returns values. An untargeted `full=1` now exceeds the compaction cap and returns the elision
envelope + hint — correct, but it means "give me literally everything" is no longer one call; use
`trait=`/`id=`/`limit=`.

The default `limit` applies only when the caller passed none, so an explicit `limit:100000` still
wins. Implemented at the **route/tool boundary**, not in `dumpSceneState()`:
`engine/electron/main.ts:638-642` (`captureGesture`'s Watch sampler) calls the `scene-state` op with
`trait:'Transform'` — targeted, so it keeps values regardless, and the producer is untouched.

### `get_layout_bounds` — counts-first, `overlaps` opt-in

The single largest payload, and the easiest to cut, because the expensive part is derived rather
than requested:

```jsonc
{
  "count": 241,
  "layerCounts": { "ui": 0, "2d": 0, "3d": 241 },
  "offScreen": [],          // ids — cheap, and diagnose.ts depends on this key
  "offScreenCount": 0,
  "overlapsCount": 2625,    // computed cheaply; the PAIRS are what's expensive to serialize
  "hint": "Counts only. Pass ids=… or layer=… for rects; overlaps=1 for the pair list."
}
```

Measured **73,849 → 68 tokens.** The bare call still reports `overlapsCount` (2,625) — the signal
survives, only the serialized pairs are gone. `overlaps=1` costs ~19,350 tok, `layer=3d` ~18,772.

- `entities[]` is returned only when `ids` or `layer` is passed, with a `limit`.
- `overlaps[]` is returned only behind `overlaps:true`, and the O(n²) pair loop
  (`layoutDump.ts:100-107`) is **guarded** so the default doesn't pay to compute 2,625 pairs it then
  discards. That double-loop otherwise emits more characters than all 241 rects combined.
- **The `offScreen` key (array of ids) is preserved.** `diagnose.ts:72` reads `.offScreen` off a
  no-arg `computeLayoutBounds()` and takes `.length` — this is the concrete instance of the
  architectural rule: summarize at the route, and `diagnose.ts`, which calls the producer
  in-process, never notices. `agentBridge.ts:280` (the `scene-state?bounds=1` enricher) passes
  `ids`, so it keeps its rects.
- `zeroSize` aggregate is included (each `LayoutEntry.zeroSize` was already computed per entry at
  `layoutDump.ts:21,51,64`; only the aggregate was missing).

### `list_assets` / `list_traits` — index-first with real filters

Both were flat full dumps of things the agent almost never needs in full.

**`list_assets`** (16,722 → ~300 tokens) defaults to per-type counts:

```jsonc
{ "total": 320,
  "byType": { "font": 136, "mesh": 114, "texture": 24, "material": 12, "particle": 10,
              "prefab": 6, "scene": 5, "model": 5, "animation": 3, "environment": 2,
              "sprite": 2, "animset": 1 },
  "hint": "Counts only. Pass type=…, folder=<prefix>, or name=<substr> for entries." }
```

`folder` (path prefix) and `name` (substring) filters are available, and the `type` filter is
applied **server-side** (previously it fetched all 320 and filtered in `index.ts:310-315`).

**`list_traits`** (10,703 → ~200 tokens) defaults to trait **names** only; `name=<Trait>` fetches
one trait's full field schema. The usage pattern is: know what exists, then fetch one schema before
a `setTrait`.

## Ring buffers, summarized at the boundary

Six surfaces each have a bounded ring buffer whose full contents can reach absurd sizes, and each has
a producer the editor UI also consumes — so the summarization lives at the seam (usually the op),
never in the producer. The ceilings below are **measured** (bytes/entry × ring cap):

| Tool | Producer (untouched) | Seam | Boundary default | Measured ceiling |
|---|---|---|---|---|
| `get_console_logs` | `dumpConsoleLogs` over the 500-entry `consoleBuffer` (`agentBridge.ts:153`) — `diagnose` reads it directly | `console-logs` op | last 50 + `byLevel` over the whole ring | ~162 B/entry → **20–27k tok** |
| `watch` (`read`) | `readWatch()` — `WatchTab.tsx:89` renders `samples` | `watch-read` op | stats-only; `samples:true` opts in | 39.8 B/sample × 512 series × 600–5000 → **3.1M–25.8M tok** |
| `journal` | `journalEvents()` — cap `10_000` (`journal.ts:58`) — `JournalTab` reads it | `journal-events` op | last 100 + `byType` | 102–226 B/ev → **257k–582k tok** |
| `editor_journal` | `readEditorJournal()` — cap `2000` (`editorJournal.ts:36`) | `editor-journal` op | last 100 + `byType`; `merged` tails `game` + `timeline` too | 130–253 B/ev → **54k–126k tok** |
| `handles` | `computeHandles()` — `inputRoutes.ts:168` calls the OP to resolve `tap_handle` | **the HTTP router**, not the op | `byEditor`/`byKind` counts unless `editor`/`kind`/`ids` | 374 B/keyframe-handle → **56k–187k tok** (2,000-key Dopesheet) |

**`handles` is the one whose seam is NOT the op.** `engine/electron/inputRoutes.ts:168` calls
`requestRenderer('enact-handles', {ids:[id]})` to turn a handle id into coordinates for trusted
input — it is an in-process consumer *of the op itself*. Summarizing there would break `tap_handle`,
so the router is the agent's boundary and the op stays an internal service.

The buffer caps are: `journal` `MAX_EVENTS = 10_000` (`journal.ts:58`), `editor_journal` `2000`
(`editorJournal.ts:36`), the agent console ring `CONSOLE_BUFFER_MAX = 500` (`agentBridge.ts:153`),
`watch` `maxSamples` default `600` per (entity,field) series × `DEFAULT_MAX_SERIES = 512`
(`watch.ts:191`, `:55`). Bounded, yes — but a `watch` on `Transform` across a populated scene has a
ceiling in the millions of tokens, which is exactly why the boundary defaults to stats-only.

Note on the console producer: the real backing store is `dumpConsoleLogs` over `agentBridge.ts`'s
500-entry `consoleBuffer`. Two *other* console buffers — the native game-debug TCP bridge
(`bridge.ts`, cap 200) and the editor Debug Menu's `ConsoleTab` capture (`consoleCapture.ts`, cap
300) — do NOT back `/api/console-logs`; the 500-entry ring is why the measured ceiling is ~20–27k
tokens, not the ~8–12k a 200/300 cap would imply.

## Fixed bugs (historical, for context)

These were the concrete waste sources, now resolved:

- **Every scene edit echoed the entire scene file back.**
  `engine/plugins/backend/editorBackendRouter.ts:505` returned
  `scene: changed > 0 ? scene : undefined`. A `setTrait` always changes something, so it always
  echoed — **~10,166 tokens per call**; a ten-edit loop burned ~100k tokens of pure echo. Worse, the
  echoed object was the pre-expansion scene *file*, not the live world, so it wasn't even the
  verification data the agent wanted. It is now gated behind an opt-in `returnScene` flag (default
  off): the route returns `{ ok, changed, errors, warnings, ...(body.returnScene ? { scene } : {}) }`.
  Nothing read the echo (hot-reload is chokidar-driven, both MCP callers forwarded the body
  verbatim), so removing it from the default is pure savings on the highest-frequency write path —
  ~10,166 → ~50 tokens.

- **`device_screenshot` inlined a full-resolution base64 image even when `savePath` was given.**
  `engine/tools/game-debug-mcp/src/mcp-tools.ts:309-362` wrote the file, opened Preview, *and*
  returned the blob (iOS `drawHierarchy` captures at ~1800px). It now returns path + dimensions as
  text and inlines the image only on an explicit `inline:true`, matching modoki's own
  `capture_viewport` / `render_scene` / `render_sequence`, which return file paths. **Coordinate
  contract caveat:** the tool's info text says "use these pixel coordinates for
  `device_tap`/`device_drag`" — if a future size fix ever downscales the returned image, the reported
  `screenInfo` scaling must move with it or on-device taps silently miss. The same change also made
  `device_eval` compact + capped and survive a circular structure (`device_eval('window')`) instead
  of throwing, and brought both `tools/` packages under `npm run verify` typecheck (neither was
  before).

- **`list_assets`'s `type` filter was applied client-side**, after fetching all 320 assets
  (`index.ts:310-315`). Moved server-side alongside the new `folder`/`name` filters.

**Not a bug — `enact-handles`'s `editor` filter.** `?editor=chrome` once returned byte-identical
output to the unfiltered call, which looked like a silently-ignored filter. It isn't: the filter is
applied server-side (`interactionHandles.ts:103-105`); the bytes matched only because all 19 handles
present happened to be chrome. Proven live: `?editor=skin` → 0, `?kind=drag` → 0. Recorded so the
next reader doesn't re-chase it.

Also verified during the work: `device_console_logs`/`device_native_logs` are NOT unbounded — both
default to `limit:50`. And `device_screencap` is a temp FILENAME
(`/tmp/_device_screencap-<pid>-<n>.png`), not a registered tool — there are 7 device tools, matching
`docs/native-and-sdks.md`.

## Where a value's shape is decided (design principle)

The tool descriptions in `index.ts` are the last mile of the budget: **a filter that isn't
advertised gets called unfiltered.** Claude picks its arguments from the tool description, so a
perfect `layer=` param on `get_layout_bounds` saves nothing if the description opens with "Get
numeric screen-space rectangles for entities." Every heavy tool's `description` states (a) the
default shape, (b) the drill-down params, (c) a size warning where the full dump is large.

The governing principle, so a newly added tool inherits it: **summary first, drill down on demand;
producers stay full-fidelity, boundaries summarize.**

## Open / deferred

These were evaluated with real BPE-tokenizer figures and are **not implemented**. The
character-based reasoning that first ranked them was wrong (see the field-share inversion above), so
they are recorded with the numbers to prevent re-litigation. Measured on the reference project (135
entities, bare index = 8,178 real tokens):

| option | tokens | saved | status |
|---|---|---|---|
| A. `guid` → fixed 12-hex prefix | 6,098 | −25% (2,080) | **deferred** — needs prefix resolution on the write path |
| B. `guid` → fixed 8-hex prefix | 5,799 | −29% (2,379) | as above; 12 hex preferred |
| C. archetype interning (`(traits, layer)` table + `a:` index) | 6,221 | −24% (1,957) | **declined** |
| A + C | 4,141 | −49% (4,037) | — |

### A/B — a fixed hex prefix on the GUID *(deferred)*

Display + ref-resolution only. Storage stays 36-char UUIDs; `isGuid` unchanged. A **fixed** prefix
is a pure function of the GUID, so an entity's short form never changes.

- **Not a git-style shortest-unique-prefix** — that varies with whatever set came back, so the same
  entity gets different short forms across calls.
- **Collisions are a non-issue at 12 hex** (48 bits; birthday p ≈ 1.8e-7 at 100k ids; zero
  collisions measured across 100k derived + 100k random ids even at 8 hex).
- **Never truncate below ~6 hex.** `deriveGuid`'s leading hex chars are the least-diffused part of a
  weak hash — see the frozen-function comment in `runtime/loaders/assetRefRules.ts`.
- **Safety property, free:** `isGuid` demands the full dashed form, so a short GUID persisted into a
  scene file is rejected loudly by `resolveRef` rather than dangling silently.
- **The real cost:** `sceneMutate` and every editor op taking `{guid}` must accept prefixes, and an
  ambiguous prefix must 400 with the candidates — **never first-match** (a duplicate id makes
  `tap_handle` silently drive the wrong element).

Deferred because the index is read once or twice per session, so 2,080 tokens is ~1% of a context
window against real write-path work. The stronger case rests on an unmeasured number: GUIDs also
appear in journal events (`@contact` carries two), watch series (one per series, up to 512), and
contacts arrays — all read *repeatedly*. A stats-only watch read across 512 series carries 512 GUIDs
≈ 10k tokens of pure identifier. Those repeated-read paths should be measured under load (a real Play
session, a broad `watch start component=Transform`) before deciding.

### C — archetype interning *(declined)*

13 archetypes cover 135 entities; the top one covers 114, repeated verbatim. It saves **24%, not the
40% the character count suggested**, because trait names tokenize efficiently (~2.9 chars/token)
while hex GUIDs fragment (1.80). Declined because:

1. **The default `limit` already solved the scaling case** — the untargeted index is capped, so it
   cannot grow unbounded; the "10,000-entity scene" justification is dead.
2. **It is the only change that makes a response *harder to read*.** Everything else made responses
   smaller *and* more informative; `{"id":23,"a":0}` is smaller and less informative — the reader
   must join a table.
3. It adds a second wire shape every future tool, test and doc must know, for a win that only lands
   on the one call you make once.

If ever revisited: use the index **table**, not grouping. Grouping entities under their trait-set
reads better on a repetitive scene, then collapses *below the flat shape* once trait-sets diversify
(39,207 vs 34,513 characters at 200 entities / 200 distinct sets). The table never loses.

### Rejected outright

- **Re-encoding ids in base62 (or any dense alphabet).** More entropy per character, **less per
  token** — 17-char base62 = 16 tokens, 12-char hex = 6. Tokens are what we pay.
- **Changing the GUID format on disk, or upgrading `deriveGuid`'s hash.** Its output is *persisted*
  (`SpritePicker` writes `deriveGuid('sprite:' + textureGuid)` into scene refs; `asset-tree-shaker`
  re-derives it). Any change dangles every 2D sprite reference in every project and needs a migration
  of every scene, prefab and `.meta.json`. FNV-1a is known-weak, deliberately contained, and frozen.

### Ceilings never measured directly

The ring caps make all of these **bounded**; the ceilings are nonetheless absurd, which is the point
of summarizing at the boundary rather than trusting the cap:

- **`watch` at cap** (~3.1M–25.8M tok) — needs a broad `start component=Transform` plus a running
  Play session. Extrapolated from ~40 B/sample × 512 series × 600–5000 samples.
- **`journal` / `editor_journal` at ring cap** (~257k–582k / ~54k–126k tok) — needs a long, busy
  Play session; a `@contact`-heavy physics session reaches the top of the journal range.
- **`handles` with a Dopesheet open on a 600–2000-key clip** (~56k–187k tok) — only the 19-handle
  chrome case was measured directly (~1,558 tok).
- **`device_screenshot` inline blob size** — needs a connected device; unbounded by resolution,
  which is why `inline:true` is opt-in.
