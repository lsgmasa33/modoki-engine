# Debug Tools (MCP) — the agent-facing debug surface

The full reference for the MCP servers an agent uses to see and drive Modoki: the
device bridge (`game-debug`), the Electron editor bridge (`modoki`), the Chrome fast
loop, and the dev-server `curl` API. `CLAUDE.md`'s "Debug Tools" section is the
in-context summary; this is the detail.

Companion design docs: [percept-plan.md](./percept-plan.md) (the Percept perception
layer — Snapshot/Journal/Watch), [enact.md](./enact.md) (the
Enact trusted-input layer), [mcp-response-budget.md](./mcp-response-budget.md) (the
response-budget design), [connect-claude-code.md](./connect-claude-code.md).

## Device debugging (device MCP + Modoki lease)

Device debugging is a **deliberate, Modoki-owned lease**, NOT auto-discovery. The human clicks
**Connect a Device** in the editor's AI panel (types the IP shown in the game's debug menu → Device
tab, or checks *Use adb (USB)* for Android); the editor backend holds one TCP socket to the device,
mints + holds a lease GUID (`.modoki/device-guid`), pings, and auto-reconnects across game relaunches
(5s grace). One backend per clone → **one device per clone**. Full guide + connection diagram:
[`engine/tools/game-debug-mcp/CONNECTION.md`](../engine/tools/game-debug-mcp/CONNECTION.md).

The `game-debug` MCP (`engine/tools/game-debug-mcp/`) is a **thin client**: every `device_*` tool
`POST`s to its clone's `MODOKI_BACKEND /api/device/request {method,params}`, which forwards over the
held socket. **The GUID never leaves the backend** (controlled comms). The MCP owns no connection —
no Bonjour, no adb, no discovery. There is **no `target` param** and no platform in the tool name;
the lease already picks the single device. Opening the lease is **deliberate** — the human clicks
*Connect a Device* in the AI panel, or an agent calls **`device_connect`** (`ip=` / `useAdb:true`, or
bare to reconnect the last target) — NOT the removed Bonjour auto-connect, and the lease is first-wins
so an explicit connect can't storm a device another editor holds. If nothing is connected, the
data-plane tools error and point at `device_connect`.

The device surface is **full Percept + Enact parity with the editor**, not just eval + screenshot.
Grouped:

- **Utility:** `device_status` (lease state / how to connect — call it when a tool errors) ·
  `device_connect` (open the lease — `ip`/`useAdb`, or bare to reconnect the last target) ·
  `device_disconnect` · `device_eval` (compact, size-capped JSON; survives a circular result) ·
  `device_screenshot` ·
  `device_console_logs` · `device_native_logs` (both default `limit:50`).
- **Percept (read-by-data):** `device_get_scene_state` · `device_diagnose` · `device_journal` ·
  `device_resolve_refs` · `device_introspect` · `device_layout_bounds` · `device_watch`.
- **Enact (trusted input):** `device_tap` · `device_drag` · `device_dispatch_action` ·
  `device_press_key` · `device_hover` · `device_scroll`.

**How the Percept/Enact tools work — one delegation, zero duplication.** The device runs the SAME game
ECS + renderer + DOM as the editor, and the Percept/Enact op registry (`engine/app/debug/agentBridge.ts`
— `scene-state`, `diagnose`, `journal-events`, `resolve-refs`, `game-introspect`, `layout-bounds`,
`watch-*`, `dispatch-action`, `resolve-dom-point`) is runtime-safe. The device bridge
(`engine/app/debug/bridge.ts` `handleMessage`) delegates any non-native method to that registry via a
**lazy `import('./agentBridge')`** → `runAgentOp`. So every device Percept tool reuses the editor's
exact shaping — summary-first, GUID-addressed, floats rounded to 9 sig-figs. The dynamic import
**code-splits** the ops into their own chunk that loads only on the first Percept/Enact request over a
live lease, so a release game (whose native server rejects connections) never loads it. `agentBridge` is
otherwise gated behind `__MODOKI_EDITOR__`, which is why this delegation is the ONE wire that brings
Percept to device.

**Prefer data over pixels on device — it's not optional on Android.** The native `captureScreen`
renders a WebGPU (Dawn/Vulkan) canvas **black** — only the DOM HUD survives — so `device_screenshot`
uses `adb screencap` for an adb lease (full framebuffer) but has nothing to fall back on over WiFi.
`device_diagnose` (render/scene health as data) and `device_get_scene_state` are the reliable channel.
`device_screenshot` returns a **PATH, not an image** (`inline:true` only when you must see pixels).

**Enact aiming — prefer a `selector`.** `device_tap`/`device_drag` resolve a CSS `selector` on-device
(occlusion-checked, no screenshot round-trip — the fix for tapping DOM chrome like a debug-menu ✕), or
take screenshot pixel coords (iOS converts off the last capture; Android passes the adb dims as
`screenInfo`). `device_drag {dom}` drags **DOM chrome** (widgets, sliders) by dispatching the pointer
sequence ON the grabbed element (auto-engaged on a non-canvas grab) — it neutralizes
`setPointerCapture`/`hasPointerCapture`/`releasePointerCapture` for the synthetic sequence, since a
synthetic pointer isn't an "active pointer" and a React drag hook's `e.currentTarget.setPointerCapture`
would otherwise throw and abort the drag. `device_press_key` dispatches keydown → brief hold → keyup on
the focused element (bubbles to `window`, where the F12 debug-menu toggle + input sources listen).
`device_dispatch_action` triggers a game intent directly and flags a `{dispatched:false}` no-op as an
error, not a phantom success. (`tap_handle`/`drag_handle` aren't ported — the game UIRenderer emits no
`data-ui-id`.) Full tool table: [`CONNECTION.md`](../engine/tools/game-debug-mcp/CONNECTION.md).

### Lease semantics & why it's Modoki-owned

Ownership is a **deliberate human action** — a session can never acquire the device on its own, only
*use* one the human connected. That kills "a session I didn't intend grabbed the device" at the root
(the old Bonjour/adb auto-connect let idle sessions in any clone grab — and *storm* — the single-client
device). The topology is controlled-comms: **control plane** (Modoki ↔ device: connect / GUID
handshake / ping / disconnect) and **data plane** (Claude → Modoki → device: eval / screenshot / tap /
drag / logs). The Claude→Modoki hop is loopback on the Mac, so proxying even an 1800px iOS screenshot
is a memcpy, not a second WiFi trip.

Why the GUID is **Modoki-generated, server-side, and persisted per clone** (`.modoki/device-guid`):
the long-lived editor owns the token (not the ephemeral app), so relaunching the *game* doesn't
invalidate it and auto-reconnect swallows every relaunch — **click Connect once per editor session**.
The token never leaves the backend; the device trusts exactly one socket. Reuses the per-clone
`MODOKI_BACKEND` convention (5179/5180/5181), so `modoki_identity`'s "which clone am I driving" guard
now covers device ops too, and manual IP deletes discovery entirely — nothing auto-connects, no race.

| Event | Behavior |
|---|---|
| **Connect** (user clicks; IP, or "Use adb") | Modoki mints/loads GUID `X`, opens the socket (WiFi to the IP, or `adb forward` over USB), sends `connect{guid:X}`. Device with no live lease → **accept**, record `X`. |
| **Game relaunch** (common) | App dies → device lease evaporates → sockets drop → Modoki auto-reconnects `connect{guid:X}` to the blank app → re-claims. No click. |
| **WiFi blip** (app alive, socket drops) | Device holds the lease a **5s grace window** before freeing, so auto-reconnect re-grabs it and ownership survives. |
| **Modoki crash / quit** | Socket drops; grace (5s) expires → device frees the lease → another editor can connect. Self-heals. |
| **Second Modoki** | `connect` with a different GUID while leased → **rejected** (device is first-wins). The incumbent auto-reconnects aggressively, so ownership stays put. |
| **Wedged** (last resort) | Relaunch the game — the in-memory lease resets unconditionally. |

**Android transport is a user choice:** *Use adb (USB)* tunnels over `adb forward`→`127.0.0.1` (the
reliable path; IP field disabled) vs. the typed IP over WiFi. iOS is always WiFi/IP. Same lease/GUID
protocol rides either transport — only the socket target differs.

## Editor debugging — DEFAULT to Electron (modoki MCP)

**The editor is shipped as the Electron desktop app, so debug it there by default.** Use the
`modoki` MCP server (`engine/tools/modoki-mcp/`), which drives the running Electron editor over
its backend (`MODOKI_BACKEND=http://127.0.0.1:<backend-port>` — 5179 main / 5180 work-ai / 5181
work-ai2 clone; see the Two Clones section of `CLAUDE.md`). This is the host you actually ship, so
it's the only place the Electron-only surfaces exist at all (main-process logs, IPC, native file
dialogs, `autoUpdate`, asar/packaging, the heal-on-open native flow) — none of which a browser tab
can see.

The MCP is **parity-plus** with chrome-devtools for the editor, and better on two axes:
- `modoki_capture_viewport` — `webContents.capturePage()`; captures the **real composited window**
  (use over a screenshot for "numbers right but renders black/NaN"). `modoki_render_scene` /
  `modoki_render_sequence` render the 3D view directly.
- `modoki_tap` / `modoki_drag` — **trusted** `sendInputEvent`; hit-tests **PixiJS + Three.js
  together** (Chrome MCP `drag` is DOM-only — you'd have to `evaluate_script` the EventSystem). Both
  now take `button` (`right`→context menu, `middle`→orbit-pan), `clickCount` (`2`→double-click), and
  `modifiers` (`shift`/`meta`→multi-select, snap). Full raw-input siblings — `modoki_hover`,
  `modoki_scroll`, `modoki_press_key`, `modoki_dnd` — and the aimed-drag layer are under **Enact** below.
- `modoki_type_text` — **trusted** keyboard input into the focused element (tap the input first);
  a real Chromium `char` event, so React controlled inputs (Inspector `BufferedTextInput`) fire
  their `onChange`. `clearFirst` replaces vs appends; `submitKey` `'Tab'`/`'Escape'` BLURs (to test
  commit-on-blur), `'Enter'` submits. This is how you author text fields (rename, `UIElement.text`)
  headlessly — the piece `tap`/`drag` couldn't reach. *(Electron editor only.)*
- `modoki_get_scene_state` / `modoki_mutate_scene` / `modoki_validate_scene` — same live-world
  data + validated edits as the curl `/api/*` endpoints, relayed over the IPC bridge.
  (`modoki_mutate_scene` ops: setTrait / **removeTrait** / addEntity / removeEntity.)
- `modoki_list_traits` / `modoki_list_assets` / `modoki_get_asset_meta` / `modoki_reimport_asset`.
  The two list tools are **summary-first**: bare, `list_assets` returns per-type counts and
  `list_traits` returns trait NAMES by category. Narrow to get detail — `list_assets {type|folder|name}`,
  and `list_traits {name:'Transform'}` for the one field schema you need before a `setTrait` (an unknown
  name errors with a did-you-mean rather than an empty object). `all:true` on either forces the full dump.

**Full editor parity (do/see everything a human can — dev AND the DMG).** These give the agent the
same actions + state a person has in the editor. They relay to the renderer over the SAME bridge
(Vite HMR in dev, Electron IPC in the DMG), so they behave identically in both:
- **See all UI state:** `modoki_get_editor_state` — selection, play state, gizmo mode/space, FPS,
  entity count, editor camera pose, undo/redo labels, and `viewport` (`innerWidth`/`innerHeight`/
  `devicePixelRatio`/`zoomFactor` — the VS Code-style UI zoom as DATA, no CDP needed) (the companion
  to `get_scene_state`). `modoki_get_console_logs` — renderer console + uncaught errors.
- **Eval live renderer state:** `modoki_eval` — run JS in the editor RENDERER and get the value back
  (the editor twin of `device_eval`). For reading/poking live state a file read can't see — a global
  (`window.__3d`), `devicePixelRatio`, a React fiber value, WGSL validation, dispatching a bridge
  event. Runs as a function body (`return x`); return a PROJECTION for anything large/circular. This
  is what removed most of the "stand up a raw CDP client" cases below. *(Electron editor only.)*
- **Play/test the game:** `modoki_play_control {play|stop|pause|resume|step}` — press Play, exercise
  with `modoki_tap`/`modoki_drag`, read `get_scene_state`, then stop (reverts the authored snapshot).
- **Edit like a human (undoable):** `modoki_create_entity` (empty/primitive/2d/ui/camera/light/
  particle — identical to the Hierarchy menu), `modoki_duplicate_entity`, `modoki_delete_entities`,
  `modoki_reparent_entity`, `modoki_set_selection`, `modoki_gizmo`, `modoki_focus_entity`,
  `modoki_history {undo|redo}`. `modoki_prefab {instantiate|create|detach}`.
  `modoki_set_transform` sets position/rotation/scale in ONE call (partial merge) and — unlike a
  plain `setTrait` — routes a prefab INSTANCE's edit into its overrides instead of being silently
  ignored; prefer it over hand-building a `mutate_scene` op.
- **Fire native menu items:** `modoki_menu` — `list` returns the app-menu tree (each node's `path`/
  `id`/`accelerator`/`enabled`); `path:"View/Zoom In"` or `id:…` fires that item's click (the same
  callback a human's click runs). This is the ONLY way to reach menu-only actions — `modoki_press_key`
  cannot trigger native Electron menu accelerators (Chromium swallows them). *(Electron editor only.)*
- **Keyboard focus:** `modoki_focus {selector?}` — focus that element, or with NO selector blur the
  focused one. The game's input sampler drops keys while a DOM text field (Console filter, an
  Inspector input) holds focus, so blur first when trusted key input mysteriously does nothing.
- **Scenes/assets:** `modoki_list_scenes` / `modoki_load_scene` / `modoki_new_scene` /
  `modoki_save_all`; `modoki_import_file` (drag-from-Finder equivalent); `modoki_project_settings`.
- **Build/deploy (heavy):** `modoki_build {web|ios|android}` / `modoki_add_native_target {ios|android}`
  — wraps the Build menu's SSE pipeline, consumed to completion; minutes-long, installs on device.

Architecture: live-editor ops register into the bridge op registry (`registerAgentOp` in
`engine/app/debug/agentBridge.ts`) from the lazy editor path
(`engine/app/editor/agentEditorOps.ts`, wired in `setup.ts` `createGameEditor`) — so editor code
stays out of game web builds. Backend routes live in the shared `editorBackendRouter.ts`
(`/api/editor-state`, `/api/editor-action` [allowlisted], `/api/scenes`, `/api/import-file`), which
both the Vite dev server and the Electron main process mount — hence the dev/DMG parity.

## LIVE WORLD vs SCENE FILE — the one rule that makes tools compose

**Two different worlds, and nothing auto-saves between them.** Miss this and you get the
single most confusing failure on this surface: an entity that is *right there on screen* and
*returned by `get_scene_state`*, while a file-editing tool insists it does not exist.

| | Tools | Writes to |
|---|---|---|
| **LIVE world only** (the running editor; undoable, like the menus) | `create_entity`, `duplicate_entity`, `delete_entities`, `reparent_entity`, `prefab` (instantiate / detach), `history`, `set_selection`, `gizmo`, `collider_edit`, `play_control`, `set_timescale` | RAM. **Not saved.** |
| **SCENE FILE** (JSON on disk; the editor hot-reloads it) | `set_transform`, `mutate_scene`, `validate_scene` (reads) | disk |
| **LIVE *and* the ASSET file** (applies live, then persists that asset — NOT the scene) | `particle_set`, `anim_set_clip`, `anim_add_key` | both |
| **ASSET file only** | `write_asset`, `create_asset`, `import_file`, `reimport_asset` | disk |
| **ASSET file *and* the LIVE world** | `prefab` (**create** → writes the `.prefab.json` **and** tags the source entities as a `PrefabInstance` in the live world, **unsaved** — run `save_all` to persist that linkage into the scene, or a reload discards it) | disk + RAM |
| **Both worlds** | `save_all` (live → disk), `load_scene` / `new_scene` (disk → live, **replacing** the live world) | — |
| **Reads the LIVE world** | `get_scene_state`, `get_layout_bounds`, `watch`, `journal`, `diagnose`, `capture_viewport`, `capture_gesture`, `get_editor_state` | — |
| **Reads the FILE** | `build`, `list_scenes`, `list_assets` | — |

**The rule: a file tool cannot see live work until you `save_all`.**

```
create_entity   → {id, name, guid}   ← live only; the file knows nothing about it
set_transform   → "no entity matching {guid} in this scene FILE"
                  hint: "…DO exist in the live editor world right now but are not in the
                         scene file yet … Run modoki_save_all, then retry."
save_all        → now the file has it
set_transform   → ok
```

**Why not just auto-save?** Because the editor is a *shared* surface: an implicit save would
commit the human collaborator's unrelated unsaved work. A surprise write is worse than a
clear error, so file tools **fail with the fix in the message** instead.

### The corollaries (each was a real, silent bug the MCP re-audit closed)

- **Address entities by `guid`, never `id`.** Runtime ids are reassigned on every hot-reload, and
  the *file* has its own id namespace, so a stale id can resolve to a **different** entity — a silent
  wrong-target on a destructive op. `create_entity`/`duplicate_entity` return the guid, and every
  live-world mutator accepts it: `delete_entities`/`duplicate_entity`/`reparent_entity`/`focus_entity`/
  `set_selection` (and `create_entity`'s parent, `prefab`'s entity/parent) take `guid`/`guids` (wins
  over `id`), as `mutate_scene`/`set_transform`/`get_scene_state {guid}` already did.
- **`load_scene`/`new_scene`/`mutate_scene`/`set_transform` REFUSE when there is unsaved live work.**
  load/new would replace the live world; `mutate_scene`/`set_transform` edit the FILE, and the write
  hot-reloads the scene — rebuilding the live world and destroying live-only entities (create_entity/
  prefab) not yet saved. `save_all` first, then the reload is lossless. (`load_scene`/`new_scene` take
  `force: true` to discard deliberately.)
- **`build` REFUSES on unsaved changes** — it reads the FILE, so the artifact would be
  missing your work. `force: true` builds the on-disk scene deliberately.
- **`save_all` after `new_scene` needs `{path}`** — there is no path yet, and the Save-As
  panel can only be dismissed by a human.
- **A tool result means what it says.** A tool that did nothing now FAILS; it does not return
  a cheerful `ok:true` with the bad news buried in a field. `unsavedChanges` on
  `get_editor_state` tells you where you stand. The re-audit swept this across the whole surface:
  `tap_handle`/`drag_handle` refuse an off-screen/disabled handle and surface `occluded`;
  `dispatch_action`/`play_clip` fail on an unknown name / stale guid / no-animator target;
  `reimport`/`import_file` fail on a no-match / unrecognized type; `timeline_set` fails when
  normalization drops a malformed item; `capture_gesture` requires the game Playing; and `diagnose`
  only counts console errors from the last 30s (a stale error no longer pins `ok:false`).

## Response budget (read this before adding a tool)

**Summary first, drill down on demand.** A bare call answers *what exists / how much*; a filter buys
the detail. A tool that returns 40k tokens can be called once before it crowds out the task it was
meant to serve. Concretely: `get_scene_state` → an index, `get_layout_bounds` / `list_assets` /
`handles` → counts, the journals + console → a tail plus a histogram of the whole ring, `watch` →
stats. Every one names its drill-down in a `hint`.

Three rules, each learned by breaking something:
- **Shape the payload at the BOUNDARY — the MCP tool, the HTTP route, or the agent op — never in a
  shared PRODUCER.** `diagnose`, `WatchTab`, and `JournalTab` read those producers in-process; a
  default applied there blanks a human's panel to save the agent tokens, and no test will catch it.
  (`handles` is the instructive exception: its boundary is the *router*, because `inputRoutes.ts`
  calls the op itself to resolve `tap_handle`.)
- **Never silently ignore a parameter.** A filter that doesn't change the answer is worse than a
  missing one — the caller believes it narrowed. An explicit `limit` always wins over a default.
- **Advertise the filters in the tool description.** An unadvertised filter gets called unfiltered.

Never truncate a payload mid-JSON: over the 60,000-char cap, `ok()` returns a valid
`{elided, bytes, hint, preview}` envelope.

**Measure tokens, not characters.** `chars/4` under-reports these JSON payloads by 25–38%, and it
mis-ranks the fields: hex GUIDs fragment (~1.8 chars/token) while trait names tokenize efficiently,
so `guid` is 43% of the bare index by tokens but only 26% by characters. Two corollaries — a dense
alphabet is a *false* economy for an LLM-facing payload (a 17-char base62 id costs 16 tokens; a
12-char hex id costs 6), and long float literals cost far more than their usefulness (hence the
9-significant-digit default on `get_scene_state`/`get_layout_bounds`/`watch`, worth 22.6k tokens
across the drill-downs). Full design + the measured per-tool budgets: [mcp-response-budget.md](./mcp-response-budget.md).

## Percept — verify by data, not pixels

**Claude is weak at visual feel — give it numbers/events.** This is **Percept**, the engine's
AI-perception layer (full design/tracker: [percept-plan.md](./percept-plan.md)). Three
primitives × two subjects: **Snapshot** ("what's true now?" — `get_scene_state`/`get_layout_bounds`/
`diagnose`/`get_editor_state`), **Journal** ("what happened, in order?" — `journal`/`editor_journal`),
**Watch** ("how did this number move?" — `watch`); over the **game world** AND the **editor session**
(what your human collaborator is doing). Provenance **sigil** on every journal event: `@` = engine-
authored, bare = game-authored, `!` = human/editor. All ride the same bridge (dev/DMG parity), and all
entity refs are **GUIDs** (hot-reload-stable). Prefer these over screenshots.
- **Semantic (game logic):** `modoki_journal` reads the tick-stamped event trace — game `emit`s
  (`match`/`score`/`win`) PLUS engine `@`-lifecycle events (`@spawn`/`@despawn`, `@anim-start`/
  `@anim-loop`/`@anim-finish`, `@contact`/`@sensor`, `@scene-loaded`/`@scene-swapped`), GUID-addressed.
  `modoki_dispatch_action` fires a game intent by name (needs Play); `modoki_list_actions` discovers
  dispatchable actions + read-values. Assert on events, not screenshots. Returns the **last 100 events
  + `byType` counts over the whole 10,000-event ring** (a `@contact`-heavy physics session is ~582k
  tokens entire) — narrow with `type=`, raise `limit=N`. (Journal is **off in shipped game builds** —
  gated `__MODOKI_EDITOR__ || build.enableJournal`; always on in the editor. On device the bridge
  turns it ON the moment a debug client attaches — on `connectionChanged` AND, because a page
  reload re-runs `main.tsx`'s disable while the native socket persists with no reconnect event, at
  bridge init via `getStatus().clientConnected` — so launch/reload-time events record during a
  debug session. Events from before the FIRST attach of a session are still unrecorded.)
- **Journal TIERS (volume control).** The journal is Percept's largest payload, so events split two
  ways. **Tier-1 always-on**: semantic events + the LEAN enter/exit transitions `@collision`/`@sensor`/
  `@zone` (low-rate — a bare read always sees them). **Tier-2 watch-gated**: the high-frequency
  diagnostic `@contact` (rich manifold: point/normal/speed) records NOTHING until you open a capture,
  and only from that point forward (no back-history). Open/close with `modoki_journal` /`device_journal`
  `action:"start"|"stop"` + `type:"@contact"` **before** the moment you want to trace. Reads report
  `captures` + a `captureHint` so an empty `@contact` result reads as "not capturing", not "no
  contacts". The editor AI panel has a **"Capture @contact on Play"** toggle (per-project) that
  auto-opens the watch when the GameView enters Play. Headless tests (`createTestWorld`) open all Tier-2
  captures by default.
- **Resolve refs → names:** `modoki_resolve_refs` / `device_resolve_refs {refs:[…]}` maps journal/contact
  refs (GUIDs and/or numeric ids) to entity **names** — the deliberate second hop that keeps names OUT
  of the (high-frequency) journal stream. Batch every ref you care about into one call after you've
  narrowed down. Names resolve **even for DESPAWNED entities** (captured at emit time in a per-world
  LRU side-table), which a live `get_scene_state` lookup cannot. Returns `{resolved:{ref:{name,alive}},
  unresolved:[…]}`. Invariant: the side-table **dual-keys** a guidable entity — it records the name
  under BOTH the GUID and the numeric id — because a live event carries the GUID while the synthesized
  despawn-EXIT carries the cached numeric id; keying only the GUID would leave the exit ref unresolvable
  (the case the feature exists for). Don't "simplify" that to a single key.
- **Watch (numeric time-series):** `modoki_watch {start|read|list|clear}` — a standing, change-detected
  series for tuning motion feel (jump overshoot, spring settle, bone/velocity decay) that a screenshot
  can't show. Focus by `component` + `guids[]` (resolved at START — a stale guid FAILS, not a silent
  empty) or `names[]` (case-insensitive substrings — NEW spawns matching a name AUTO-JOIN, the handle
  for a runtime-spawned entity whose guid changes every launch, e.g. the sling puck); optional
  `fields[]`. Anti-flood knobs `epsilon` (record only on change), `everyNFrames` (decimate),
  `maxSamples` (ring cap), `maxSeries` (cap on MOVING series — a static/never-moved entity doesn't
  consume it, so a screen of static tiles can't crowd out a late-joining mover), `expireFrames`
  (auto-expire). `read` returns per-series stats `first/last/min/max/delta/settled` + each series'
  entity `name`; narrow a broad watch with `name=`/`guids=`/`limit=` (`seriesTotal`/`seriesTruncated`
  report the full match count). Editor-side observer — zero shipped-game cost. (`app/debug/watch.ts`.)
- **Editor session (perceive the human):** `modoki_editor_journal {type,source,since,sinceCap,merged,limit,clear}`
  — the human-authoring stream (`!` sigil: `!select`/`!edit`/`!transform`/`!create`/`!duplicate`/`!delete`/
  `!reparent`/`!play`/`!pause`/`!stop`/`!gizmo`/`!scene-load`/`!save`/`!undo`/`!redo`), GUID-addressed with
  old→new values on edits. Every event carries **`source:'human'|'agent'`** so you never mistake YOUR
  own edits for the human's (agent-driven editor ops self-tag `'agent'`). `merged:1` interleaves it with
  the game journal by a shared capture counter for the "pressed Play → set timeScale 0.3 → `@match` tick 84"
  correlated story. All three streams return the **last 100 + `byType` counts**; cursor precisely with
  `since`/`sinceCap`, or raise `limit=N`. (`editor/editorJournal.ts`.)
- **Numeric layout:** `modoki_get_layout_bounds` → **bare it returns COUNTS** (`count`, `layerCounts`,
  `overlapsCount`) plus the cheap `offScreen`/`zeroSize` **id lists** — usually the whole answer to
  "what's invisible or collapsed?". Pass `ids`/`layer` for per-entity screen-space rects (UI DOM rects
  + projected 2D/3D), and `overlaps:true` for the same-layer overlapping PAIRS — that list is O(n²) (2,625
  pairs, 77k chars ≈ 19k tokens on a 241-entity scene), so it's opt-in. Check alignment/overlap/clipping as data.
  (Providers register in `Scene3D`/`Scene2D`; UI via `[data-entity-id]` DOM. New:
  `runtime/rendering/screenBounds.ts`, `app/debug/layoutDump.ts`.)
- **Diagnose:** `modoki_diagnose` → structured causes (bad refs, NaN/zero-scale transforms, no camera,
  off-screen, console errors) — run FIRST when something renders wrong. (`app/debug/diagnose.ts`.)
- **Console:** `modoki_get_console_logs` returns the **last 50 + `byLevel` counts** over the 500-entry
  ring (error entries carry full stacks, so the whole ring can exceed 20k tokens). `limit`/`level`/`since`
  narrow it.
- **Asset authoring (no guessing JSON):** `modoki_asset_schema {material|particle|animation}` →
  field metadata + example; `modoki_create_asset` / `modoki_write_asset` (validated, warn-but-write);
  live tuning via `modoki_particle_set` / `modoki_anim_set_clip` / `modoki_anim_add_key` /
  `modoki_set_playhead` (apply live AND persist). New schema layer: `runtime/assets/assetSchemas.ts`.
- **Time + input feel:** `modoki_set_timescale` (0=pause/0.3=slow-mo/2=fast — pair with
  `render_sequence`); `modoki_capture_gesture` (Electron) drags while sampling an entity's Transform
  per frame → a numeric trajectory for tuning input feel.
- **Snapshot (`modoki_get_scene_state`):** **called bare it returns an INDEX** — per entity `id`,
  `guid`, `name`, `parentId`, `layer` + its trait **NAMES**, no field values, under a default `limit`,
  plus a `hint`. That's the cheap "what exists?" question; ask it first, then drill down. (It used to
  dump every field of every trait: ~40k tokens on a 135-entity scene.) **Any target or enricher returns
  VALUES:** filters `trait`/`id`/`guid` (the stable address to prefer)/`name` (substring)/`where`
  ("Trait.field op value" — **reports a parse/unknown-field error** instead of silently dumping everything); enrichers `full` (full-fidelity
  trait dump — AoS/object fields the compact default drops, PLUS runtime read-back fields like
  `SkeletalAnimator.activeClip`/`normalizedTime` and RigidBody `isSleeping`), `world` (resolved world TRS
  + `activeInHierarchy`), `bounds` (per-entity `screen` rect + `onScreen` + 3D `worldAABB {size,center}`),
  `contacts` (live solid `contacts` + sensor `overlaps`, GUIDs), `resources` (include resource entities,
  excluded by default), `limit` (+ `truncated`/`totalCount`; an explicit `limit` always wins, and a
  targeted query is never silently capped). **Floats are rounded to 9 significant digits**
  (`247.13061935179246` → `247.130619`; max error 3.5e-7) — ~18–21% of the tokens on a Transform
  drill-down. **Verify an edit with a TOLERANCE, not `===`.** `precision=0` returns exact float64;
  the same param exists on `get_layout_bounds` and `watch`.

## Enact — act like a human, not just read like one

**Enact is the input twin of Percept.** Percept made every editor surface *readable* (numeric
bounds/journal); **Enact** makes every human *interaction* *sendable* — the trusted-input layer so the
agent can do anything a mouse+keyboard can, in dev AND the DMG. Reach for it when a
`mutate_scene`/`editor-action` shortcut doesn't exist and you must drive the actual UI (author in a
Canvas2D/SVG editor, exercise a gesture, open a modal). All are Electron-editor trusted input except
`dnd`/`handles`, which ride the editor-action relay and work in dev too. (Design:
[enact.md](./enact.md).)
- **Aim by `selector`, not by pixels.** `modoki_tap`/`drag`/`hover`/`scroll` take an optional CSS
  `selector` instead of `{x,y}`, resolved to the element's centre **server-side in the same call** —
  so nothing can move between reading a coordinate and acting on it (drag takes a `{selector}` per
  endpoint). The response reports `matched` (what the selector found), `hitTarget` (the topmost
  element at that point) and `occluded`: when `occluded` is true **something covered your target and
  the click landed on it** — the silent-miss class of bug, as data, with no screenshot. Occlusion is
  measured at resolve time, a few ms before dispatch, and is **provenance, not a veto** (the input is
  still sent). A hidden/zero-rect element or an invalid selector is refused with a 400 rather than
  aimed at (0,0). Keep `{x,y}` for canvas/entity targets, from `get_scene_state?bounds=1`.
- **Raw input modalities** (beyond `tap`/`drag`): `modoki_hover` (bare mouse-move → tooltips/hover-
  submenus), `modoki_scroll` (wheel → orbit-zoom, scroll a long panel, cursor-anchored Canvas2D zoom;
  `deltaY>0` = content down, ~120 ≈ one tick; pass `modifiers:['control'|'meta'|…]` to drive a
  modifier-gated wheel handler — Ctrl/Cmd+wheel UI-zoom, the Curve Editor value-axis zoom), `modoki_press_key` (standalone chord into the focused
  element — `Escape`/`Delete`/arrows + hotkeys `W`/`E`/`R` gizmo, `F` frame, `Cmd+Z` — the keys
  `type_text` could only send as a terminal `submitKey`).
- **Sustained/HELD pointer** (`modoki_pointer {action:down|move|up}`) — the stateful twin of
  `modoki_drag`, split across calls: `down` presses and LEAVES the button held, `move` re-aims it
  (drag-move), `up` releases. The press physically persists between MCP calls, so state that exists
  only *while the button is held* — a slingshot pull preview, a charge-up meter, a drag-to-aim
  rubber-band — is readable mid-gesture (`get_scene_state`/`modoki_eval`/screenshot between the
  down and the up), which the atomic `drag`/`dnd` cannot expose. move/up reuse the held button;
  a move/up with nothing held (or a second down while held) is a 409.
- **HTML5 drag-and-drop** (`modoki_dnd`) — the DnD sequence a trusted pointer-drag CANNOT emit:
  Hierarchy reparent/reorder, Assets file-move & prefab-instantiate, Skin sprite-onto-part / bone-
  reparent. Address each end by CSS `selector` or `{x,y}`; the app's own `dragstart` fills the
  DataTransfer (never fabricated). Returns the MIME `types` written (empty ⇒ wrong source element) +
  `accepted`, and **reports `ok:false` when the drop was a no-op** (empty transfer or a rejecting
  target) — so a wrong-source/wrong-target reparent is a visible failure, not a silent success.
  Use this, NOT `modoki_drag`, for asset→slot / reparent.
- **Editor chrome is addressable — `modoki_handles {editor:'chrome'}`.** Panel buttons, the Inspector's
  per-trait `⋮` and its menu rows, toolbar toggles, the Console filter, dialog confirm/cancel all carry
  `data-ui-id="<panel>.<region>.<name>"` and surface as handles, so `modoki_tap_handle {id}` drives them
  with **no new input tool and no pixel measuring**. Ids are stable and semantic
  (`inspector.section.Transform.menu`, `contextmenu.item.Copy Component`, `sceneView.toolbar.gizmo.rotate`,
  `hierarchy.toolbar.create`, `prefab.dialog.confirm`). Each handle reports `rect`, `meta.disabled` (a
  greyed control is DATA, not a shade of grey) and `occludedBy` (what covers it — occlusion is computed
  for EVERY handle that names an owning element, not just chrome; `occlusionUnchecked` counts the ones
  that named none, so **`occludedCount:0` only means "all clickable" when `occlusionUnchecked` is 0 too**).
  **A handle only exists when its panel is rendered** — an empty result means "open that panel / select an
  entity first", never "guess the pixels". Adding a surface = add the attribute; a guard test
  (`tests/editor/chromeTagging.test.ts`) fails if a load-bearing id is deleted, and a duplicate id logs a
  loud error (`tap_handle` resolves the first match, so a duplicate silently drives the wrong element).
- **Aimed input for the Canvas2D/SVG editors (the input twin of `get_layout_bounds`).** These editors
  (Skin bones, Dopesheet/Curves keyframes, Collider2D vertices, particle curve/gradient points, gizmo
  axes, sprite-slice/9-slice/UI-resize handles) have **no DOM accessibility tree** and a downscaled
  capture ≠ CSS coords, so raw drag is useless — you don't know WHERE to aim. `modoki_handles` **called
  bare returns COUNTS** — `byEditor`/`byKind` (plus `viewport`, `offScreenCount`, `occludedCount`,
  `occlusionUnchecked`, `disabledCount`) — the "what can I aim at right now?" answer. Pass
  `editor`/`kind`/`ids` for the geometry: each handle then has a stable `id`,`x`,`y`,`label`,`meta` and
  `onScreen`, in viewport CSS px, with `viewport {w,h}` for image-px↔CSS mapping. The full list is
  opt-in because a Dopesheet enumerates every key of every track (~374 bytes each — a 2,000-key clip is
  ~187k tokens). Then `modoki_tap_handle {id}` / `modoki_drag_handle {id, to|toId|delta}` issue the
  trusted gesture — coords resolved **server-side** from the id, so no query→drag race.
  **All counts 0 ⇒ open the right editor + enter its sub-mode first** (see openers below); if a
  handle is `offScreen`, `modoki_scroll` the panel until it's aimable rather than silently missing.
- **Openers/mode-setters that unblock editors trusted input can't reach** (a native `<select>` popup or
  a modal that only mounts when its tab/asset is active is a separate OS layer `sendInputEvent` can't
  touch): `modoki_scene_view_mode {3d|ui}` (REQUIRED before Collider2D editing — its vertex handles
  only live in `ui`/2D mode), `modoki_collider_edit {on}` (the toolbar "Points" toggle),
  `modoki_open_particle_editor` / `modoki_open_sprite_editor` / `modoki_open_nine_slice_editor` (pass
  the asset's served path — mounts the panel/modal so its handle providers register). `get_editor_state`
  now reports `sceneViewMode`/`colliderEditMode`.
- **Canonical loop:** open the editor/sub-mode → `modoki_handles` to discover geometry → `drag_handle`/
  `tap_handle` (or `dnd`) to act → verify via Percept (`get_scene_state`/`watch`/`get_layout_bounds`)
  → `modoki_history undo` to revert. Registry twin of `screenBounds.ts`:
  `runtime/rendering/interactionHandles.ts` + `app/debug/handlesDump.ts`; raw modalities in
  `engine/electron/rendererOps.ts`; DnD synth in `engine/app/debug/domDnd.ts`.

## Electron CDP (when the MCP/Percept surface can't answer)

Need full CDP (network inspection, perf traces, heap snapshots) against Electron? Its renderer
speaks CDP too — launch Electron with `--remote-debugging-port` and point `chrome-devtools` at
the Electron window; `--inspect` debugs the main process. So nothing CDP-shaped is lost in Electron.

**Try `modoki_eval` first.** For a one-shot read/poke of live renderer state (a global, a fiber
value, `devicePixelRatio`, dispatching a bridge event, a WGSL compile check), `modoki_eval` returns
the value over the normal MCP bridge with no CDP client to stand up — it's the editor twin of
`device_eval` and removed most of the cases below. Reach for full CDP only when you need a CDP-native
capability `eval` can't give you: sampling a clock/state **over time**, network/perf/heap inspection,
or observing a transient the very act of an HMR-triggering edit would mask.

**REACH for Electron CDP when the MCP/Percept surface can't answer — don't avoid it.** The
`modoki` MCP + Percept tools (now including `modoki_eval`) are the default and cover most editor
debugging, but some questions are only answerable by inspecting the live renderer directly, and past
sessions have wrongly avoided this and gone in circles instead. Attach CDP when you need to: read **live React
fiber/component props or state** (e.g. what `node.textAnim` a UINode actually received — the
projection value, WITHOUT a source edit); measure **CSS-animation clocks / computed transforms /
`getAnimations()` `currentTime`** over time (motion the console can't show); diagnose
**compositing/repaint** ("numbers right, renders static") or **WebGPU/WGSL validation errors**
(invisible to `modoki_get_console_logs`); or count **duplicate module instances** (distinct Vite
module URLs). Critically: a **source-edit probe triggers an HMR that re-renders and MASKS
first-load/transient bugs** — CDP `Runtime.evaluate` (and fiber reads) let you observe the live
buggy state without perturbing it. To reproduce a true cold-start bug, relaunch Electron fresh
(not `location.reload()`, which can leave the renderer half-initialized — `fps:0`, empty tree).

Concrete recipe (used to fix the Game-view UI-text-animation bug): relaunch this clone's editor
with the debug port (same backend/project so the MCP stays valid) —
`pkill -f "$PWD/engine/electron/dist/main.cjs"; MODOKI_BACKEND_PORT=5180 MODOKI_PROJECT=games/<id> \
./node_modules/.bin/electron --remote-debugging-port=9223 "$PWD/engine/electron/dist/main.cjs" &`
— then find the page target via `curl -s localhost:9223/json` (filter to the `/#/editor` url). The
`chrome-devtools` MCP manages its OWN browser and usually CAN'T attach to an arbitrary Electron
port, so drive CDP directly: a ~30-line Node script using `ws` opens the page's
`webSocketDebuggerUrl` and calls `Runtime.evaluate` with `returnByValue`/`awaitPromise` (put the
script IN the repo dir so `ws` resolves — ESM ignores `NODE_PATH`). The backend (5180) is separate
from the renderer, so the modoki MCP keeps working through the reload.

The minimal script — evaluate an expression in the live renderer without perturbing it (write it
under the repo root as `cdp-eval.mjs`, run `node cdp-eval.mjs "<expr>"`):

```js
import WebSocket from 'ws';
const PORT = process.env.CDP_PORT || 9223;
const expr = process.argv[2] ?? '1+1';
// 1. find the editor page target
const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('/#/editor'));
if (!page) throw new Error('no /#/editor page target — is Electron up with --remote-debugging-port?');
// 2. open its CDP socket and Runtime.evaluate
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));
ws.on('message', (buf) => {
  const m = JSON.parse(buf);
  if (m.id === 1) { console.log(JSON.stringify(m.result?.result ?? m.error, null, 2)); ws.close(); }
});
send(1, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
```

Read a live fiber/prop, a `getAnimations()` clock, or a WGSL error object the same way — the
`expression` runs in the page context. Use `returnByValue` for serializable results; drop it (and
read `result.objectId`) for live handles. This observes the buggy state WITHOUT the source-edit HMR
that would mask a first-load bug.

## Chrome/Web debugging (chrome-devtools MCP) — opt-in fast loop

**Use this only as the fast renderer-iteration loop** (scenes, UI, shaders) — NOT as the primary
editor debugger. It loads the same Vite-served renderer in a plain browser tab, so it cannot see
any Electron-only surface, and the browser transport can quietly drift from what you ship. When a
bug is Electron-shaped (packaging, native, IPC, autoUpdate), switch to the `modoki` MCP above.

**DO NOT reach for Chrome to debug/verify the EDITOR.** Default to the Electron editor via the
`modoki` MCP for anything editor-shaped — it's what ships, and the clone's Vite port can vanish
mid-session (connection refused) leaving you stuck. In particular, when a `modoki_tap` MISSES a
target, do NOT switch to Chrome to work around it — fix the AIM in Electron. In order of preference:
pass a CSS `selector` (resolved server-side; the response's `occluded`/`hitTarget` tells you if
something covered it), or `{x,y}` from `get_scene_state?bounds=1`. **Never eyeball coordinates off a
capture:** `modoki_capture_viewport` downscales to 1568px longest side, so image px ≠ CSS px — it now
returns `cssWidth`/`cssHeight`/`scale` (image px ÷ `scale` = CSS px) precisely so you never have to
guess. Chrome is a browser-tab renderer loop only, never the editor debugger.

**Re-read bounds immediately before acting.** A camera move, a relaunch, or a scene reload between a
bounds read and a tap invalidates the coordinates. Nearly every "the tool is broken" moment has been a
stale read, not a bug. `selector`/`tap_handle` resolve inside the call and don't have this problem.

**Which editor is `MODOKI_BACKEND` pointing at?** Multiple clones of this repo run side by side, each with
its own editor on its own port. Pointed at the wrong one, **every call succeeds and drives the other
checkout** — nothing errors, nothing you expect changes. `modoki_identity` (or `GET /api/identity`)
answers `{repoRoot, projectRoot, backendPort, pid, branch}`; the MCP also warns on every tool result
when the backend's `repoRoot` isn't this session's. Call it first when edits seem to vanish.

**Addressing entities across hot-reloads:** in `scene-mutate` / editor-action ops, target entities
by `{guid}` or `{name}`, NEVER `{id}`. Runtime numeric ids are reassigned on every scene hot-reload
(and a mutate itself triggers one), so a remembered `{id}` can point at a different entity after the
next call — e.g. a restore mutate using a stale `{id:23}` once stamped a trait onto a prefab-instance
entity instead of the intended one. Only trust an `id` within a single call with no intervening reload.

Launch Chrome with `--remote-debugging-port=9222` pointing to the clone's port.

**Main branch (5173):**
```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 http://localhost:5173
```

**Second clone (auto-picked port):**
The clone's dev/editor Vite server now auto-picks a free port (see the Two Clones section of `CLAUDE.md`) — it's no longer pinned to 5174. Use whatever port `launch-editor.sh` / `npm run dev` printed, on a distinct debugging port:
```bash
open -na "Google Chrome" --args --remote-debugging-port=9223 http://localhost:<clone-port>
```
- Screenshot: `take_screenshot` with `format: "jpeg"`, `quality: 70`
- Tap: `click` by element UID (from `take_snapshot`)
- Drag: use `evaluate_script` to call PixiJS EventSystem directly (Chrome MCP `drag` is for DOM drag-and-drop, not canvas gestures)
- Eval: `evaluate_script`
- Console: `list_console_messages`

## Native Debug Bridge (capacitor-game-debug)

Standalone Capacitor plugin at `engine/packages/capacitor-game-debug/`. Runs a TCP server on the device for the MCP server to connect to.

**Platform details:**
- **iOS:** NWListener (TCP) + native lease handshake + `captureScreen` + `getNativeLogs` (OSLogStore)
- **Android:** ServerSocket (TCP, first-wins single client) + native lease handshake + `captureScreen` + `getNativeLogs` (logcat)
- **No Bonjour/mDNS on either platform** — advertising was removed from the plugin; the backend connects by IP/adb.

**Debug vs Release (two layers):**
- **Native plugin** — iOS: `#if DEBUG` gates plugin registration in MyViewController; Android:
  `FLAG_DEBUGGABLE` runtime check rejects in release. So a store/release-signed build has no native
  TCP server.
- **JS bridge** (`app/main.tsx` → `./debug/bridge`, which carries `handleEval` = arbitrary JS) —
  gated by the `build.debugBridge` project flag (Project Settings → Developer), baked as
  `__MODOKI_ENABLE_DEBUG_BRIDGE__`. Default **false** → the whole `./debug/bridge` import
  tree-shakes out of a shipped game build (native AND web), so there is no eval-capable JS server at
  all; the editor + dev keep it always-on. This is the layer that also covers the web
  (`VITE_DEBUG_BRIDGE`) path and closes the pre-existing gap where the JS bridge was ungated on
  native even though the native plugin was `#if DEBUG`-gated. Turn it ON per-game to debug on-device
  (the 6 internal native testbeds already set it).

**Known issues:**
- iOS SPM static linking strips the plugin class — requires manual registration in MyViewController + Xcode file reference from App target to `engine/packages/capacitor-game-debug/ios/Sources/GameDebugPlugin/GameDebugPlugin.swift` (project-relative path in pbxproj, no copy). Edit the package source only.
- **Android screenshots use `adb screencap`** — but only when the **lease itself is adb** (`target.useAdb`,
  from `/api/device/status` — F2), NOT merely because some Android is on USB (that would screenshot the
  wrong device when the lease is a WiFi iPhone). A WebGL/WebGPU (Dawn/Vulkan) canvas inside the Android
  WebView composites in a separate GPU surface, so the device's native `captureScreen` (`rootView.draw()`)
  renders it **black** — only the DOM HUD survives; `adb screencap` reads the post-composition
  framebuffer, capturing the 3D scene + HUD together. `device_screenshot` uses it for an adb lease and
  stores the capture dims so `device_tap`/`device_drag` still convert coordinates. It's a read-only side channel (no game commands → doesn't
  touch the lease) and needs the device on USB; **iOS** captures fine natively through the lease.

**MCP screenshot + tap coordinates:**
- `device_screenshot` returns image pixel dimensions; pass the same coords to `device_tap`/`device_drag`.
  On **iOS** the device stores its own capture dims and converts coords itself. On **Android** (adb
  capture) the MCP remembers the adb dims and passes them as `screenInfo` so the device can convert.
- iOS captures at higher res than native (e.g., 1800 from 1260 native); the image is large — don't
  eyeball coordinates, use `device_eval` to query `getBoundingClientRect()`.
- **Canvas offset gotcha**: The PixiJS canvas starts at `CSS top ≈ 27` (below the React HUD), not y=0.
  Use `device_eval` to get `canvas.getBoundingClientRect().top` and cell positions.
- **Debug markers**: The bridge shows red/green/cyan dots and dashed lines on tap/drag. Check
  `device_console_logs` for `[debug-bridge]` coordinate logs.
- The device TCP server accepts only **one client** (first wins) — the backend lease is the single
  owner, so nothing else can cross-wire.
- Do NOT use `sleep` between MCP commands — the game launches fast and MCP commands are synchronous. Claude's thinking time is longer than any sleep.

**Connection docs:** `engine/tools/game-debug-mcp/CONNECTION.md`

## Agent Dev-Server API (AI-friendly scene editing)

Dev-only endpoints + scene hot-reload so an AI agent (or any tooling) can edit scenes via plain `curl` and verify the result **without driving a browser/screenshot**. All dev-only (the asset-scanner middleware only runs under `vite` dev). Server: `engine/plugins/vite-asset-scanner.ts`. Browser client: `engine/app/debug/agentBridge.ts` (gated on `import.meta.hot`, stripped from prod). Pure logic (shared Node + browser): `packages/modoki/src/runtime/scene/{sceneValidation,sceneMutate,sceneSchema}.ts`; ref predicates in import-free `runtime/loaders/assetRefRules.ts`.

- **Scene/prefab hot-reload** — editing a scene file on disk (the `Edit` tool, `git checkout`, `/api/scene-mutate`) auto-reloads the **active** scene in the browser; editor camera + selection are preserved (selection via the existing GUID-keyed `selectionRestore`). A prefab edit reloads the current scene (instances re-expand). The watcher classifies files with the scanner's own `detectType()` — **scene files here are plain `.json` under a `scenes/` dir, not `.scene.json`**. The editor's own Cmd+S saves (`/api/write-file`) are suppressed (1.5s self-write guard) so they don't bounce the live scene; external edits still reload.
- **`curl localhost:5173/api/scene-state[?trait=Transform][&id=N]`** — returns the **live ECS world** as JSON. **Bare it is an INDEX** (`{scenePath, entityCount, entities:[{id,guid,name,parentId,layer,traits:[names]}], hint}`), capped at a default `limit` of 200 entities — past that it clips and gains `truncated`/`totalCount`. Pass a target (`trait`/`id`/`name`/`where`) or an enricher (`full`/`world`/`bounds`/`contacts`) to get trait **values** (`traits` becomes an object); a targeted query is never capped unless you pass `limit`. Relays to the open tab over the HMR socket (504 if no app is open). Because it reads the live world (not the file), a changed value here proves a hot-reload actually took effect. **Prefer this over screenshots to verify scene edits.**
- **`curl .../api/validate-scene?path=/games/.../x.json`** — warn-but-load validation: unknown trait/field, type mismatch, and the literal-asset-path-instead-of-GUID mistake (see "Asset References" in `CLAUDE.md`). Needs a tab open to push the trait schema (`schemaAvailable:false` ⇒ ref checks still run, type checks skipped).
- **`POST .../api/scene-mutate {path, ops}`** — validated `setTrait`/`removeTrait`/`addEntity`/`removeEntity` (entity ref by `id`/`name`/`guid`; mints GUIDs); writes atomically; returns `{ok, changed, errors, warnings}`. Hot-reload then reflects it. It does **NOT** echo the scene back (that fired on every edit and cost ~10k tokens of context for data nobody read — and it was the pre-expansion *file*, not the live world). Pass `returnScene:true` if you actually want the written file; **to verify an edit, read `/api/scene-state`.**
- **`GET .../api/editor-state`** + **`POST .../api/editor-action {action, …}`** (allowlisted) + **`GET .../api/scenes`** + **`POST .../api/import-file {srcPath, destFolder}`** — the editor-parity surface (live UI state read; selection/play/undo/scene/prefab/entity actions; scene list; Finder-style import). `editor-state`/`editor-action` relay to the renderer, so they need a tab/editor open. See the modoki MCP section above for the tool wrappers.

**Gotcha:** the Vite plugin loads once at server startup. Editing the plugin **or any module it imports** (`sceneValidation`, `sceneMutate`, `assetRefRules`) requires a dev-server restart (`curl /api/exit` + `npm run dev`). Browser-side modules (`agentBridge`, `sceneSchema`) hot-update normally.
