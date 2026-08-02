# Pairing mode — parking on `modoki_wait_for_edit`

**What it is:** a loop where the agent parks on a blocking read instead of driving the editor,
wakes when the *human* commits an edit, and reacts to what changed. It exists so an agent can sit
alongside a human working in the SceneView/Inspector without burning turns polling
`modoki_editor_journal` in a tight loop. It is a workflow built on top of two tools that already
ship — `modoki_wait_for_edit` and `modoki_editor_journal` — not a separate mode the editor knows
about; nothing on the editor side is aware an agent is "pairing".

**When to use it vs. the normal drive-the-editor loop:** the normal loop (`create_entity` →
`set_transform` → `save_all`, etc., see [debug-tools-mcp.md](./debug-tools-mcp.md)) is for when
the agent is the one making changes. Pairing mode is for the opposite direction — the human is
editing and the agent needs to notice and respond (verify a change as it happens, keep a running
commentary, react to a value the human just tuned). Don't reach for it just to "wait" — a single
`modoki_editor_journal` poll (or just asking the human) is enough for a one-off check.

## The tool: `modoki_wait_for_edit`

Source of truth: `engine/tools/modoki-mcp/src/contracts.ts` (`modoki_wait_for_edit` entry),
implementation in `engine/tools/modoki-mcp/src/tools/editor.ts`, backend route
`GET /api/wait-for-edit` in `engine/plugins/backend/editorBackendRouter.ts`, op in
`engine/app/editor/agentEditorOps.ts` (`wait-for-edit`), core wait logic
`waitForEditorJournal()` in `engine/packages/modoki/src/editor/editorJournal.ts`.

- It is a `GET`, `kind: 'read'` tool — parking does not mutate anything.
- Params: `type` (optional — an editor event type like `!edit`, `!transform`, `!select`; omit to
  wake on any type), `source` (`'human' | 'agent'`, **defaults to `'human'`** — the whole point is
  noticing what the human did, not the agent's own MCP-driven edits), `since` (a prior `seq`/
  `nextSeq` cursor; omit to wait for the *next* event from now, not to replay history),
  `timeoutMs` (default 30000, clamped server-side to `[50, 120000]` —
  `WAIT_FOR_EDIT_MIN_MS`/`WAIT_FOR_EDIT_MAX_MS` in `agentEditorOps.ts`).
- If a matching event already happened after `since`, it returns **immediately** — you are never
  made to wait for something that already occurred.
- Otherwise it blocks (a real held HTTP request, not client-side polling) until a matching event
  arrives or `timeoutMs` elapses.
- Result shape (`WaitForEditResult`): `{ events: EditorEvent[], timedOut: boolean, nextSeq: number }`.
  A timeout is `{ events: [], timedOut: true, nextSeq }` — a **normal** answer, not an error. Advance
  the cursor with the returned `nextSeq` on every subsequent call (never re-use a stale one).
- The client-side transport timeout is set to the clamped server deadline + 15s headroom
  (`editor.ts`), so a legitimate 120s park does not read as "backend unreachable".

### The loop

```
modoki_wait_for_edit { timeoutMs: 120000 }        # source defaults to 'human'
  → { timedOut: true, events: [], nextSeq: N }      # nobody touched anything — call again
  → { timedOut: false, events: [...], nextSeq: M }  # the human committed something — react, then:
modoki_wait_for_edit { since: M, timeoutMs: 120000 }  # resume parking from where you left off
```

For a longer watch than 120s, just call again with the advanced cursor — there is no single-call
"watch forever."

## What wakes the agent, and what it does NOT get told

Each `EditorEvent` in the returned `events` array (same shape as `modoki_editor_journal`,
`engine/packages/modoki/src/editor/editorJournal.ts`) carries: `seq`, `cap` (shared game+editor
capture order), `ts` (wall-clock — editor code is not determinism-guarded), `type` (a `!`-prefixed
event, e.g. `!edit`, `!select`, `!create`, `!transform`, `!undo`, `!save`, `!play`), `source`
(`'human' | 'agent'`), and an optional `payload`.

A trait-field `!edit` additionally carries a structured `detail: {trait, field, entities[guid],
old[], new[]}` (documented in `debug-tools-mcp.md`'s `editor_journal` notes) — this is the one
event type detailed enough to react to without a follow-up read. Two things it does **not** give
you reliably:

- **A continuous drag's `detail.new` is the FIRST frame of the drag, not the settled value.** Read
  the final value live from `modoki_get_scene_state` rather than trusting the event payload for
  anything mid-drag.
- **Compound multi-field edits (e.g. SpriteAnimator clip/track ops) are label-only** — no `detail`
  at all. For those, and for anything you need beyond what the event says, go read state yourself:
  `modoki_get_scene_state` (what an entity looks like now), `modoki_get_editor_state` (selection,
  play state, `unsavedChanges`), or a wider `modoki_editor_journal` call (`merged:true` also pulls
  in the game journal + an interleaved `timeline`, useful for lining a scene edit up against what
  the game did in response).

The wake event is a **notification that something happened**, not a diff you can act on blind —
this is the same "observe, don't infer" rule as the rest of the debug surface
(`debug-tools-mcp.md`): the event tells you *that* the human edited something and roughly *what
kind* of edit it was; it does not replace reading current state before you react to it.

## Timeouts and exiting the mode

- No pairing "session" object exists — there is nothing to explicitly enter or exit beyond the
  agent's own control flow. "Exiting" pairing mode just means the agent stops issuing another
  `modoki_wait_for_edit` call and goes back to driving the editor (or ends the turn).
- A timeout (`timedOut: true`) is not a failure and not a signal to stop — it means the human
  hasn't done anything in that window. The natural loop is to keep calling with the advanced
  `nextSeq` (or the same `since` if it timed out with no events) up to as many turns as the task
  warrants; there is no built-in cap on how many times you may re-park.
- If the human never edits, the loop runs forever at the agent's discretion — nothing server-side
  ends it. Budget this against the turn/token cost of each 120s park before parking repeatedly with
  no other work interleaved.

## Gotchas that apply here (inherited from the rest of the MCP surface)

- **A game-code (`.ts`) edit force-reloads the editor and DISCARDS unsaved scene edits** after a
  5s countdown (`docs/editor-hmr.md`). If you are parked in a pairing loop and the human's next
  edit is a game-code change, the reload happens regardless — check
  `modoki_get_editor_state.unsavedChanges` before making any edit of your own while paired, and
  don't let the agent's own actions be what triggers a reload that eats the human's unsaved work.
  `discardedUnsavedEdits: true` on a later `get_editor_state` call records that it already
  happened; `staleGameCode: true` means a reload was cancelled and you are reading from a stale
  build.
- **Address entities the human just edited by `guid`, never `id`.** Runtime ids are reassigned on
  every hot-reload (a mutate itself can trigger one), so an id captured from an earlier event may
  no longer point at the same entity by the time you act on it.
- **Re-read bounds/state immediately before acting**, not from the woken event's payload alone — a
  camera move, relaunch, or reload invalidates coordinates, and (per above) a continuous-drag
  event's `detail.new` is a first-frame snapshot, not the settled value.
- **`source` filtering only separates human vs. agent MCP-driven edits** — it does not distinguish
  which human, and it does not see anything outside the editor (a native dialog, a file edited
  directly on disk outside the editor's own writers won't appear as an editor-journal event unless
  it triggers a scene reload).

## What is NOT implemented (the issue's premise, checked against source)

The originating issue frames this as "push human edits to the agent." What actually ships is a
**pull with a long-poll block** — the agent must be the one to call `modoki_wait_for_edit` again
after each wake; nothing calls back into the agent, there is no subscription/webhook, and there is
no persistent "pairing session" state on the editor or backend side. Concretely, none of the
following exist in the current code: an explicit `pairing_mode` on/off tool, an event push over a
socket the agent listens on unprompted, or any limit/backoff on how many times an agent may re-park
tail-to-tail. Treat "pairing mode" as this doc's name for the *pattern* of using
`modoki_wait_for_edit` in a loop, not as a named feature with its own on/off switch.

## Related

- [debug-tools-mcp.md](./debug-tools-mcp.md) — the full agent-facing debug surface, Percept/Enact,
  `editor_journal`'s `detail` shape, the `!` sigil, `source:'human'|'agent'`, LIVE WORLD vs SCENE
  FILE, and the observe-don't-infer rule this doc's "what wakes you" section leans on.
- [editor-hmr.md](./editor-hmr.md) — what force-reloads the editor and why a game-code edit
  discards unsaved scene work.
- [mcp-persistence.md](./mcp-persistence.md) — `unsavedChanges`, manual-only persistence, and the
  gates keyed off it.
- [enact.md](./enact.md) — the trusted-input twin, for when the agent's reaction is to act back
  into the editor rather than just observe.
