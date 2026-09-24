# Editor keyboard input — focus scope + keymap registry

Every keyboard shortcut in the editor is declared in **one registry** and dispatched by **one
window listener**, resolved against the **focused panel**. This doc is the contract: what a scope
means, what claiming vs. yielding a chord does to the Electron menu, and how editor focus gates
the running game's input.

Mouse is deliberately **not** focus-filtered — DOM hit-testing already routes it. Mousedown only
*sets* focus.

## Key files

- `editor/input/keymap.ts` — `register`/`unregister`/`resolve`, chord normalization (`mod` → ⌘ or
  Ctrl by platform), `formatChord` (the `⌘D` / `F2` / `⌫` glyphs the context menus show),
  `KeymapConflictError`.
- `editor/input/dispatcher.ts` — `installKeymapDispatcher()`, the single `window` keydown listener.
- `editor/input/focusScope.ts` — `isTextEditable()` + the overlay stack (`pushOverlay`/`popOverlay`/
  `topOverlay`, and `isModalOpen`/`subscribeOverlays` for the modal kind).
- `editor/components/ModalShell.tsx` + `editor/components/modalBackdrop.ts` — the one full-screen
  modal shell, React and plain-DOM forms; see [Modals block the editor](#modals-block-the-editor-underneath-them-1270).
- `editor/input/PanelFocusHost.tsx` — click-to-focus wrapper applied by `EditorApp`'s FlexLayout
  factory, so **every** panel gets focus acquisition at one seam.
- `editor/input/useOverlayEscape.ts` — `useOverlayEscape()` (push + bind Escape) and `useOverlay()`
  (push only, for overlays that own other chords).
- `editor/store/editorStore.ts` — `focusedPanel` + `setFocusedPanel`.
- `runtime/input/inputSources.ts` — `setInputGate` / `isInputSuppressed` (see
  [input.md](./input.md)); the editor's policy is installed in `EditorApp.tsx`.

## The `preventDefault` contract — the load-bearing rule

Measured, not assumed (physical keypresses against the dev editor; synthesized input **cannot**
answer this question — see Gotchas).

> **The renderer sees a key BEFORE the Electron menu, and `preventDefault()` is what suppresses
> the menu accelerator / native role.**

So the dispatcher's whole body is a two-line contract:

- **Claimed** (`resolve()` returned a binding) → `preventDefault()` **and** run it.
- **Yielded** (`resolve()` returned null) → do **nothing**. No `preventDefault`.

Yielding is what lets ⌘C in a text field reach the native `role:'copy'`, ⌘R reach reload, and
⌘⌥I reach devtools. A dispatcher that called `preventDefault` unconditionally would kill every
native role editor-wide, silently, with no error anywhere.

Two corollaries that are easy to get backwards:

- **`when()` returning false means YIELD, not swallow.** It removes the binding from the
  candidate set, so a lower scope — or the menu — gets the chord. Never use `when` to express
  "claim it but don't preventDefault".
- **That's what `Binding.preventDefault()` is for.** Claiming and preventing are separate
  decisions: a binding may legitimately deny a chord to every lower scope while still letting the
  browser's default run (the SpriteEditor modal claims ⌘Z so a global undo can't unmount it
  mid-edit, but must not block typing). Getting this wrong produced a real bug — an
  `when: notTyping` guard yielded ⌘Z to `app.undo`, which then ran the scene undo underneath an
  open modal.

The same measurement showed there is **no double-dispatch**: a chord bound both as a menu
accelerator and as a renderer binding fires once, because the renderer's `preventDefault`
suppresses the menu path. The menu keeps its `shortcut:` labels purely as display.

**Worked example — ⌘⇧N, measured 2026-07-22.** It is bound twice: the Electron menu's
"New Project…" (`engine/electron/projects.ts`'s `installAppMenu`) and Assets' New Folder
(`editor/panels/Assets.tsx`'s `handleKeyDown`, `'new-folder'` case). With the **Assets panel
focused**, a physical press creates a folder and the New Project dialog does **not** open —
single dispatch, Assets wins. Two things this pins that the contract alone did not:

- It holds for a **raw DOM handler**, not just registry bindings — Assets' handler is
  element-scoped and outside the keymap (the `TODO(P8)` comment above `Assets.tsx`'s
  `handleKeyDown`), yet its `preventDefault()` still suppresses the native accelerator.
- The outcome had been asserted twice from theory ("swallowed by New Project", then
  "double-fires") and **both were wrong**. It is also not answerable by tooling: synthesized
  input never reaches a native accelerator, and macOS focus-stealing prevention blocks an agent
  from raising the editor to send a real one. A human at the keyboard is the only instrument.

## Scope tiers

Five, resolved by priority. `resolve()` picks the highest-priority candidate for the chord.

| Tier | Fires | Members |
|---|---|---|
| `overlay` | only for the top of the overlay **stack**; outranks everything, so it may swallow an app-chord. While a **modal** is on the stack it is the only tier that resolves | Escape-to-close, the SpriteEditor modal's ⌘Z |
| `text-field` | when `document.activeElement` is text-editable | Enter/Escape commits, Backspace-clears-ref |
| `<panelId>` | only when that panel is focused, and never while text-editable | everything panel-specific |
| `app-key` | everywhere **except** text-editable | *(no registrations today — see note)* |
| `app-chord` | everywhere, **text fields included** | ⌘S, ⌘Z, ⌘⇧Z, ⌘P |

The two-way split of "app" is the whole point: a command must not fire while you type into a name
field. ⚠️ **`app-key` currently has ZERO registrations** — `grep "scope: 'app-key'"` returns nothing.
This doc long cited `f` ("frame selected") as its canonical example, and that was wrong: `f` is
registered TWICE at PANEL scope (`Hierarchy.tsx`, `SceneView.tsx`), each deliberately, because
`app-key` fires from every panel and framing should follow the panel you are in. The tier exists and
is wired; nothing uses it yet. A panel scope is a **FlexLayout tab component
id** — `scene`, `game`, `hierarchy`, `inspector`, `console`, `assets`, `particle-editor`,
`animation-editor`, `timeline-editor`, `spriteanim-editor`, `skin-editor`, `ai`, plus any
game-registered id.

A command that logically belongs to more than one panel registers **once per scope** (Hierarchy's
selection commands are registered under both `hierarchy` and `scene`, so copy/paste works with the
viewport focused). Rename stays Hierarchy-only — the edit box lives on a row.

## Modals block the editor underneath them (#1270)

An overlay is one of two kinds, and the difference is what happens to a chord it did **not** bind:

- **A popover** (ContextMenu, the pickers using `useOverlayEscape`, FontPicker, SpritePicker) claims
  only what it binds. ⌘S under an open context menu still saves.
- **A modal** blocks the editor underneath it. While one is **anywhere** on the stack, `resolve()`
  makes every non-overlay scope ineligible — panel, `app-key`, `app-chord` — so Delete, ⌘Z and ⌘S
  reach no editor shortcut. Anywhere rather than on top, because a picker or context menu opened
  over a modal must not be what lets ⌘Z through when it closes. The editor's game-input gate closes
  too (`EditorApp`'s `setInputGate`), so a running game does not receive keys under a dialog.
- **A modal takes DOM focus** when it opens (`holdFocus` in `modalBackdrop.ts`) and gives it back on
  close. The keymap gate alone was not enough: an element-level `onKeyDown` fires for whatever holds
  DOM focus, and the Assets list keeps focus after a click, handles ⌘⌫/⌘D/Enter itself and stops
  propagation — so ⌘⌫ under Project Settings trashed the selected asset (found in review, by code
  trace). Focus is left alone when the dialog already placed it with `autoFocus`.
- **The React shell portals to `document.body`.** Five dialogs open from inside a panel (the Sprite
  and 9-slice editors in the Inspector, the two animation pickers, the Re-import-all confirm). A tab
  FlexLayout hides keeps its content mounted under `display:none`, so an unportalled dialog in a
  hidden tab would still block every shortcut and grey the menu with nothing on screen to close.

The failure it removes: a Replace prompt open over Create Prefab, Delete pressed with the Hierarchy
focused, and the entity deleted underneath the prompt — which then wrote a prefab of an entity that no
longer existed. Every full-screen dialog had its own backdrop and none of them registered.

What still works under a modal, on purpose:

- **The modal's own keys.** Its overlay-scope bindings (SpriteEditor's slice ⌘Z/⌘⇧Z/⌘Y) resolve as
  before, and element handlers inside it (a prompt's Enter/Escape) fire before the window dispatcher.
- **Typing and native roles.** Ineligible means `resolve()` returns null, which YIELDS (the
  `preventDefault` contract above) — ⌘C in the dialog's field, ⌘R, devtools.

**The menu refuses too.** Under Electron the relayed menu is a second way in: an OS-menu click, and
an accelerator whose chord the dispatcher yielded, both land in `handleMenuAction`. So:

- `buildMenuSpec(menus, { modal })` greys **every** renderer-built item while a modal is open. That
  is the refusal a human sees before clicking, and `/api/menu` reads the same `enabled:false` and is
  refused by `triggerMenuItem`, with the open modal named as the cause (`electron/modalRefusal.ts`).
  Observed live 2026-09-16 with Project Settings open: every renderer item `enabled:false`, the
  main-owned ones enabled, `Edit/Undo` refused.
- `handleMenuAction` reads the overlay stack itself and refuses with a toast. Greying takes an IPC
  round-trip after the dialog opens, and a click or accelerator inside that window would otherwise run
  the command.

**One shell draws every modal.** `<ModalShell kind=… onDismiss=…>` in React, `openDomModalShell()` in
`utils/saveDialog.ts` (which has no React by design). Mounting or opening pushes the modal entry, so
the registration cannot be forgotten by a dialog that draws its own backdrop — the shape all 17 had.
`onDismiss` is the backdrop dismiss, and it fires only for a press that starts AND ends on the scrim:
a drag-select that starts in a field and is released outside does not close the dialog. Both forms
stamp `data-modal-shell=<kind>` on the backdrop, so "which modals are open" is one DOM query —
`modoki_dnd` reads it to report a drop that raised a confirm (`pendingModal`, #1471). The plain-DOM
dialogs also name their box `<kind>` and each control `<kind>.<role>` (`save-dialog.confirm`,
`<choice-kind>.<value>`, #1470) so an agent aims by name.

**Agents are told.** `/api/input/key` warns when a press landed under a modal and no binding of the
modal's own claimed it, instead of answering `ok:true` alone.

What it does **not** cover:

- **Main-owned menu items** — File ▸ New/Open Project, Open Recent, About, Check for Updates, the
  View zoom items and every native role. They are built by the main process, not from the renderer's
  spec, so they are neither greyed nor refused.
- **Agent HTTP ops.** An MCP mutation or `modoki_history` undo does not go through the keymap or the
  menu, and is not gated by an open modal.
- **The IPC window.** Greying the menu is a round-trip after the dialog opens. A `/api/menu` click
  inside it reaches `handleMenuAction`, which refuses — but main has already answered `ok:true`.
- **The web (non-Electron) editor's browser defaults.** A blocked ⌘S or ⌘P yields, and with no
  Electron menu to swallow it Chrome then opens Save Page As or Print. Under Electron nothing happens.
- **The Scene Load modal's first 400ms.** It renders nothing until the delay elapses (so warm loads
  never flash it), and it blocks only once it is showing.
- **A finished build's dialog blocks the Build menu until it is closed.** `docs/editor.md`'s build
  refusal deliberately does not count a FAILED build as running, so a retry needs no dismissal; the
  modal kind now requires one click on Close first. Consistent with the rule, and a one-prop change on
  `BuildProgressModal` if it proves the wrong call.

## Focus is store-backed, not `document.activeElement`

`focusedPanel` lives in `editorStore` and is set on capture-phase pointerdown by `PanelFocusHost`.
This is load-bearing: clicking a Hierarchy row (a plain `<div>`) does **not** move DOM focus —
every measured keypress after such a click reports `target=BODY`. A derived-from-`activeElement`
model has to special-case "still run when activeElement is `<body>`", which is exactly the hole the
old `data-editor-panel` half-mechanism had.

Focus is also kept **out of the FlexLayout model**: `onModelChange` debounce-saves the layout and
re-pushes the native menu over IPC, so model-resident focus would rewrite the layout autosave on
every click.

Other properties worth knowing:

- **Not undoable, ever.** Focus is transient chrome; storing it would flood the undo stack and
  create a routing feedback loop (undo changes focus → the next ⌘Z routes elsewhere). Focus may
  *follow* undo (reveal the owning panel), but is always derived, never `pushAction`ed.
- **Not persisted** across launches.
- **Observable as data** — `focusedPanel` is in `modoki_get_editor_state`, alongside `openPanels`
  (every id with an open tab), and a scope change journals `!focus {panel, from, to, source}` (on
  change only, never per keystroke). A focus ring that existed only as CSS would make "which panel
  owns keys?" a screenshot question, which [debug-tools-mcp.md](./debug-tools-mcp.md) forbids.
- **Drivable** — `modoki_press_key` and `modoki_focus` take a `panel` argument. The route fails
  loudly (400, naming the ids that ARE open) when that panel isn't open, because a panel-scoped
  chord aimed at a closed panel is otherwise a silent no-op: the dispatcher just yields. `panel` and
  `selector` stay separate on `modoki_focus` — keyboard scope and `activeElement` are different
  questions.

### ⚠️ That "fails loudly" was a TAUTOLOGY until #301 — and this doc asserted it anyway

The guard existed and could not fire. `/api/input/key` compared the renderer's echoed
`focusedPanel` against the `panel` it sent; the renderer's `set-focus-scope` op handed the string
straight to `setFocusedPanel`, which is a bare `set()` — so the echo **always** equalled the input.
The comparison could only fire if the renderer had *changed* the value, which it never did.
`/api/input/focus` did not attempt the check at all.

What that cost: `modoki_focus {panel:"Game"}` answered `{ok:true, focusedPanel:"Game"}`, but the
input gate compares against `'game'`, so it stayed **shut** and every following `modoki_press_key`
reached nothing — each also reporting `ok`. That is the QA-PHYS-0003 failure above reached by a
second route the incident never closed: there the panel was *forgotten*, here a wrong value is
*accepted*. Miscasing is not a contrived input — this doc, `CLAUDE.md` and the tool descriptions
all say "the Game panel" in prose, and nothing types the ids.

The fix refuses on **open-ness**, not on a vocabulary list:

- `editorStore.openPanels` is published by `EditorApp` from the one FlexLayout model walk it
  already does for the Window menu (keyed on the model being ready + `layoutVersion`).
- `set-focus-scope` refuses a `panel` outside that set, returns `openPanels`, and **does not move
  the scope** — a half-applied focus is worse than none, because the caller cannot tell which it got.
- Both routes share one `setFocusScope` helper, so they cannot drift again. A renderer predating
  the op's `ok` field degrades to the old echo-only behaviour rather than blocking all input.

Open-ness rather than a `z.enum` of ids, for two reasons: a game can register **custom panels**, so
no fixed list can be right; and open-ness is a superset of the typo case — it is what the error
message already promised.

Two things the adversarial pass then caught in that fix itself, both now closed:

- **`openPanels` must be published SYNCHRONOUSLY, never from an effect.** It was first written
  as a `useEffect` keyed on `layoutVersion`, which publishes one React commit *late* — and
  `set-focus-scope` reads the store with a plain `getState()`. A call landing in that window is
  answered from the pre-change list: the human closes a tab, the agent focuses it, and the op
  reports `ok` for a panel that is already gone — the very failure this fix closes, reopened
  through a timing gap. `publishOpenPanels` is therefore called from the two points where the
  model can change (the initial load, and the top of `onModelChange`), in the same synchronous
  turn as the change. **Do not move it back into an effect.**
- **A non-string `panel` is refused, not stored.** The open-ness test only guards strings, so
  anything else fell through to the bare setter. That is reachable, not theoretical:
  `set-focus-scope` is on the `/api/editor-action` allowlist, so
  `{action:'set-focus-scope', panel:12345}` bypasses the MCP tool's `z.string()`. Measured on a
  live editor: `ok:true`, and `get_editor_state.focusedPanel` then reported the **number**
  12345 — which the gate's `p !== null && p !== 'game'` reads as "some panel owns the
  keyboard", suppressing all game input permanently with no panel to blame.

**The lesson worth carrying past this bug:** the test suite covered this route and stayed green,
because the renderer *fake* modelled a rejection by changing its echoed value — behaviour no real
renderer ever had. A guard whose only evidence is a fake that flatters it is not a guard. Both
halves are now mutation-checked (neuter the refusal → 4 route tests and 2 op tests fail):
`engine/tests/electron/inputRoutes.test.ts` and `engine/tests/editor/setFocusScopeOp.test.ts`.

## The runtime input gate — mechanism vs. policy

While an editor panel other than the GameView owns the keyboard, the **running game** must receive
nothing. Otherwise typing WASD in the Hierarchy latches the character's movement keys, and a
gamepad drives the game while you edit the Inspector.

The split mirrors the injectable clock: **the runtime supplies the mechanism, the editor supplies
the policy.**

- `runtime/input/inputSources.ts` exposes `setInputGate(fn)` / `isInputSuppressed()`. It lives on
  the source **registry**, not in `keyboardSource`, because all three sources leak and only one had
  any guard: keyboard (window keydown, `editing()` only), pointer (**no guard**), gamepad
  (**polled, no guard**).
- `EditorApp` installs `() => focusedPanel !== null && focusedPanel !== 'game'`. **A shipped game
  never calls `setInputGate`**, so the default gate stays null → zero behaviour change in a build,
  and `createTestWorld`/headless is untouched.
- **A closed gate DRAINS every frame** (`reset()` on each source), rather than once on an edge.
  Hold `W`, click the Hierarchy, and the character must stop — otherwise `sample()` keeps
  reporting `w` held until physical release. The same drain stops a queued backlog (pointerSource's
  press FIFO fills with any in-scope press made while the gate is closed) from replaying into the
  game on reopen. Before #1182, that meant every click on an editor panel; the ingestion scope below
  now drops those at press time.
  ⚠️ It must NOT reset on the REOPENING edge, which is what it used to do (#264): `PanelFocusHost`
  moves the scope on capture-phase pointerdown, so a click into the Game panel opens the gate and
  lands in the queue in the same tick — and the reopening reset then ate it, along with the rest of
  that gesture (`reset()` nulls `activeId`, so the later move/up fall through). First click lost,
  second fine, which reads as flaky. Measured live 2026-08-19: pre-fix the first tap delivered 0
  presses to the game and the second delivered 1; after, the first delivers 1.
- **Null focus deliberately does not suppress**: pressing Play and immediately using WASD has to
  work without first clicking the GameView.
- The gate **fails open** if the policy function throws — and so does the DRAIN. A source whose
  `reset()` throws is reported once, by name, and skipped; the rest still drain. That guard is
  load-bearing only because the drain is per-frame: `frameDriver` auto-unregisters a callback
  after 10 *consecutive* throws, and the callback here is the whole `'ecs'` pipeline, so an
  unguarded throwing reset would let one buggy game-registered source kill physics, animation
  and transforms by leaving a non-game panel focused for ~166 ms. The old edge-triggered shape
  could not reach 10 in a row (the next suppressed frame returned early and ran clean, which
  clears the count). `sample()` stays unguarded — it is unchanged, and always ran per frame.

### The pointer ingestion scope — the gate's press-time twin (#1182)

The gate decides what the game **reads** each frame. It cannot stop what the pointer sources do at
**press** time, before any frame samples: `pointerSource` latches the gesture and
`setPointerCapture`s the press target, and `gestureSource` adds the pointer to its list. Both listen
on `window`, and the only press-time filter was the pointer-block registry, which is a denylist that
editor chrome never joins. So every press on a panel or modal was captured by the game. That
overrode the panel's own capture: the Sprite Editor canvas ended up holding capture instead of its
scroll viewport. It also made any outcome-only check of a panel's capture unfalsifiable, because a
release off the canvas still arrived through the game's capture.

- Mechanism: `setPointerIngestScope(fn)` in `runtime/core/pointerBlockers.ts`. A press, or a wheel
  notch, whose target the host's predicate rejects never reaches either source. It **fails open**:
  only an explicit `false` excludes, and a throwing predicate counts as in scope. A shipped game never
  installs one.
- Policy: `EditorApp` installs `isGamePointerTarget` (`editor/input/gamePointerScope.ts`) right beside
  the gate. A press is the game's only if its target is inside `[data-game-view-area]`, the Game
  panel's play area. That area holds the canvases and the UI layer (plus the Stopped overlay and the
  debug menu) but not the panel toolbar. This is the same marker `app/debug/uiSurface.ts` uses for
  the Game panel's surface.
- **Containment, not focus** (owner, 2026-09-14): `PanelFocusHost` cannot see a modal portalled out
  of the panel tree. A focus rule would still hand a Sprite Editor press to the game whenever the Game
  panel was the last one clicked.
- Not folded into `isPointerBlocked`: a blocked press is the game's own chrome taking it, and it
  journals `input.pointer.blocked`. An out-of-scope press is not the game's business, and it must not
  journal a game event for every editor click.
- The input watch (`pointerRecorder.ts`) marks such a press `outOfScope: true`. It keeps it out of
  the queue that receives the game's `noteInputResolution()`, and out of `unresolvedOnly`.
  Otherwise an editor click would take the next real tap's resolution, or be listed as a press the
  game missed.
- A real press outside the scope still ends a STRANDED synthetic gesture (#299), at that gesture's
  own last point, and then latches nothing. Checking the scope before that takeover cannot stop it:
  the debug bridge presses with `pointerId: 1`, the real mouse's id, so the click's `pointerup`
  would end the gesture anyway, at the click's coordinates.
- SceneView's 2D and 3D drags were never affected: their capture-phase canvas listeners call
  `stopPropagation`, so those presses never reach `window`.

### The agent-facing half: a suppressed key used to look identical to a delivered one

The gate is right, and it was also **invisible**. `modoki_press_key` answered `ok:true` whether the
key reached the game or was dropped at the gate, and its own docs named only the OTHER gate (a
focused text field), telling callers to fix it with a bare `modoki_focus {}` — which clears DOM
focus and does not touch `focusedPanel`. A QA run followed that advice literally, pressed `d` 80
times at a running platformer with the scope stuck on `scene`, measured a byte-identical
`Transform.x`, and reported the character controller broken (testboard `xfMfBSDskBmFY7phWSVm`).

`/api/input/key` now asks the renderer one read-only question BEFORE dispatching —
`probe-key-reach` → `editor/input/keyReach.ts` — and reports:

- `focusedPanel` on **every** press, not only when the caller set it;
- a warning when the press reached **nothing**: `isInputSuppressed()` is true AND `resolve()` found
  no binding for the chord in the current scope.

Both halves of that condition are load-bearing. `gameInputSuppressed` alone is true through most
ordinary editor work — a `w` that sets the gizmo mode with the Scene panel focused is correct usage
— so warning on it would fire on nearly every press and be tuned out within a session. Paired with
"no binding claimed it", the press is a **provable** no-op, which is worth interrupting for.

**What `editorBinding: null` does and does not prove.** It rules out the keymap registry, which
is the editor's only window-level *chord* listener (`dispatcher.ts`, plus one Shift-snap modifier
watcher in SceneView that binds nothing). It does not rule out an element-level `onKeyDown` — a
text input, the Add-Component picker, `AssetRefField` — which fires while that element holds DOM
focus; `activeElement`, reported in the same response, is that half of the answer. So the warning
says the key never reached the running game, and deliberately does **not** say the press did
nothing at all.

The probe calls `isInputSuppressed()` and `resolve()` rather than re-deriving
`focusedPanel !== 'game'` in the main process: the policy above is stated in exactly one place and
a second copy would drift the first time the gate learns a new condition. The one fact that *is*
duplicated across the process boundary — the arrow-key name aliases — has a drift guard
(`engine/tests/electron/keyReach.test.ts`), because a one-sided addition there would make the
warning lie on that key alone.

## Never make a commit depend on a focus EVENT (#233)

Chromium dispatches `focus` and `blur` **only while `document.hasFocus()`**. With the editor window
behind another window — an ordinary state for a human, and the PERMANENT one for any agent-driven
MCP session — `el.blur()` still moves `document.activeElement` but fires **no event**. So the
familiar field idiom

```tsx
onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}   // ✗ commit never runs
onBlur={(e) => commit(e.target.value)}
```

silently does nothing: the value is typed, Enter is pressed, and nothing is written. Nothing errors.

**The rule: Enter commits DIRECTLY.** Keep `onBlur` committing too — that is the click-away path, and
a click-away only happens while the window IS focused, which is exactly when the browser does deliver
the event.

```tsx
onKeyDown={(e) => { if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); } }}
onBlur={(e) => commit(e.target.value)}
```

Two consequences that are easy to get wrong, both of which cost a real bug in #233:

- **The trailing `blur()` DOES fire `onBlur` when the window is focused**, so `commit` runs twice.
  Make it idempotent — and check per site rather than assuming, because a guard that compares against
  a **prop** is stale in that same synchronous tick (React has not re-rendered). A ref updated inside
  `commit` is what actually closes it.
- **That idempotency guard must be RESET when the value changes externally** (an undo, another panel,
  a reselect). It exists only to swallow the trailing blur, and held longer it becomes the very bug it
  was added to prevent: re-entering a previously-committed value compares equal and silently does
  nothing.

The same applies to `onFocus`: any state it gates is dead in an unfocused window. Drive
"is the user mid-edit?" from `onChange`, which fires regardless.

### A per-keystroke commit needs a THIRD pattern: guard on the ECHO, not on focus (#242)

The two rules above fit a field that commits on a terminal signal. A field that commits on **every
keystroke** — `useBufferedValue`, which backs every Inspector field, and `ParticleEditor`'s
`NumInput` — has no terminal signal to hang an `editingRef` off, and its `focusedRef` guard was dead
in an unfocused window. **What clobbered the buffer was the field's OWN commit**: clearing it commits
`parse('')` = 0, the store echoes 0 back, the re-sync effect rewrites the empty buffer to `'0'`, and
the remaining keystrokes land on that. Measured on `games/sling` Lvl-0002: `-3.5` typed into a
cleared `Transform.x` stored **0** and left the field reading `0-3.5`, with `modoki_type_text`
reporting success.

**The rule: skip the re-sync when the text on screen already MEANS the store's value.** At that point
re-syncing can only reformat it (`''` or `'-'` → `'0'`), which is the destruction itself and never
new information; a genuine external change (a gizmo drag, an undo, a reselect) does not parse-match
and still re-syncs.

```tsx
useEffect(() => {
  if (focusedRef.current) return;
  setLocalValue((cur) => (Object.is(parse(cur), externalValue) ? cur : String(externalValue)));
}, [externalValue]);
```

⚠️ `parse` is read through a **ref** in the real code, not closed over as above. It is an inline
arrow at most call sites, so as an effect dep it would re-run this on every render and clobber any
text that has not yet round-tripped through the store — and omitting it from the deps without a ref
is a stale closure plus a lint warning. The `setLocalValue` updater is what keeps `localValue`
itself out of the deps, which matters for the same reason.

- **This rule alone was not enough — see the next section (#1411).** It was first shipped
  stateless, on the argument that remembering what the field committed goes stale. That argument is
  right about an UNBOUNDED memory, and it is why the memory #1411 added is cleared three ways.
- **Two known costs, both deliberate.** A non-injective `parse` — `BufferedNumberInput`'s min/max
  clamp — cannot be told from a reformat, so typing `1.8` into a `max=1` field leaves the display on
  `1.8` while the store holds `1` until blur reconciles it. That is what a FOCUSED window already
  did, so the fix aligns the two rather than inventing a behaviour; but with no blur in an
  agent-driven session, **read the value back with `modoki_get_scene_state`, never off the field.**
  And in mixed (multi-select) mode the guard is skipped entirely, so entering mixed mode still clears
  the buffer and shows the `----` placeholder.
- **`ParticleEditor`'s `NumInput` had the same defect and auto-saved**, so the corrupted value reached
  disk with no Save at all (it wrote on a trailing timer, by design — until #259 made the panel park
  its document for Cmd+S like every other surface). Typing `-3.5`
  into one of its clamped fields committed **0.5** — the clamp of an in-progress `-3` to 0 is what
  moved the store and supplied the echo. Most of its number fields are clamped (25 of 38 carry a
  `min`/`max`, by `grep -nE "<(Num|NumInput)\b[^>]*(min|max)=\{"`), so the exposure is the panel,
  not a corner of it.

### …and a LATE echo of an earlier keystroke (#1411)

The echo rule compares the store's value with the text *on screen now*. But the Inspector samples
the store once per frame (its rAF-coalesced refresh), so at typing speed the echo that arrives can
belong to an EARLIER keystroke. It matches nothing on screen and looks exactly like an external
change. **Measured live** in an unfocused editor (`games/anim-bug`, the name field, the alphabet
typed by `modoki_type_text`): React wrote `…qr` over `…qrs`, the `t` landed after it, and the `s`
was gone — about one character lost per run, at a random position. A focused window never shows it,
because `focusedRef` skips the whole re-sync.

**The fix: the field remembers what it committed.** `resyncBuffered`
(`editor/panels/bufferedEcho.ts`) is the whole decision, shared by `useBufferedValue` and
`ParticleEditor`'s `NumInput`:

- A store value that equals the text on screen → keep the text (the #242 rule).
- A store value found in the field's pending commits → a late echo: keep the text, and drop that
  entry and everything before it (echoes arrive in commit order).
- Anything else → a real external change: re-sync, and **forget every pending entry**.

The memory is cleared three ways, and each one closes a stale-memory failure the review found:
1. **Any external change** clears it, so a value dragged away and back re-syncs.
2. **A change of owner.** Inspector fields are keyed by field NAME, so one instance survives a
   selection change. The Inspector provides `BufferedFieldScope` (its selection) and the Particle
   Editor provides it too (the effect's path, since its Sections survive a retarget). A new scope
   clears the memory. A blur clears it as well, when one fires. Without this, typing `ab` into A's name and selecting B (named `a`) within the
   window left `ab` on screen for B.
3. **Time**: an entry expires after `ECHO_WINDOW_MS` (1 s), stamped AFTER the write so a slow
   `onChange` cannot expire its own entry. The commit that ends an edit has nothing after it to
   consume it, and nothing may wait for a blur to clear it (#233).

**One ambiguity is deliberate, and cannot be closed without an identity on the echo.** Echoes are
coalesced, so `1`, `12`, then a backspace to `1` in one frame is answered by ONE echo of `1`. That
consumes the first `1`, and `12` lingers for up to a second. An undo to `12` inside that second is
skipped and the field shows `1`. Clearing on a match with the LATEST entry would fix this and bring
#1411 back whenever echoes are not coalesced, which is the worse trade. As with the clamp above:
in an agent-driven session, read the value back from the store, never off the field.

Tests: `engine/tests/editor/bufferedEcho.test.ts` (the decision) and
`engine/packages/modoki/tests/editor/fields.test.tsx` § #1411 (the hook's wiring: the record, the scope
reset, the stamp order).

### …and an echo ROUNDED by the caller: the field owns its display precision (#1407)

Both rules above recognise an echo only if the value comes back EXACTLY as it was committed. The
Inspector broke that by rounding before the field ever saw the value:
`value={parseFloat(displayVal.toFixed(2))}`. Typing `4.1256` committed 4.1256 and got back `4.13`.
That value was never committed and does not equal `parse(text)`, so the field's own commit looked
like an external change and overwrote the text mid-edit. **Measured live** (`games/sling`
block_showcase, two entities selected, focus guard disarmed to model the unfocused window):
`modoki_type_text` refused with `valueAfter "4.13"` while both entities held 4.1256. It measured the
field correctly; the field was the one that was wrong. This needs a keystroke that CHANGES the
rounded value, so `1.2345` never shows it and `-12.125` does.

**The fix: the field owns its display precision.** `BufferedNumberInput` takes `precision`, and the
caller passes the **raw** value. `roundedTo(precision)` (`bufferedEcho.ts`) supplies `resyncBuffered`
with a comparator (equal when rounded to the same value, for both the #242 check and the #1411 check)
and a format (for the re-synced text, the initial text and the blur reconcile).

⚠️ **Passing the raw value is only safe WITH the comparator.** A degree field stores radians, and the
round trip is noisy: 30° → rad → `29.999999999999996`°. The caller's `toFixed` used to absorb that
noise. With the raw value but exact matching, typing `30` left the field showing
`29.999999999999996` mid-edit. That was a live revert-run, and it was the one observation that told
this fix apart from "just stop rounding at the caller".

**Two comparators, because the two checks have different lifetimes** (`EchoMatch` in
`bufferedEcho.ts`):
- `same` matches a pending commit (the #1411 check). It may be loose, at the displayed precision,
  because an entry expires after `ECHO_WINDOW_MS`.
- `means` is the #242 check. It has no expiry and holds until the next external change or a blur,
  which in an unfocused window may never come, so it must be tight: float noise only (12
  significant digits).

The first version used the display precision for both, and the review caught it. An undo from
`4.1256` to `4.13` left `4.1256` on screen with no time limit. The documented cost of the loose
`same`: for up to one second after a commit, a genuine external change equal to that commit at the
display precision is taken for its echo. That is the #1411 ambiguity again, and it has the same
bound.

**The same shape in a string field: `ColorField`'s hex box.** It is fed hex RE-DERIVED from the
stored colour (lower-case, with the alpha byte appended). Typing `#aabbcc80` committed the colour at
`#aabbcc`. The `#aabbccff` echo rewrote the text, and the `80` then built `#aabbccff80`, which is
invalid, so the alpha was never committed. `HEX_ECHO` (`widgets.tsx`) is its `EchoMatch`, and the
two comparators split on alpha:
- `same` (pending, at most one second): the same colour, and a 6-digit COMMIT matches an echo with
  ANY alpha, because `commitHex` leaves alpha alone for it. It works only in that direction. An
  8-digit commit echoed back as 6 digits (pasted into a colour with no alpha channel) means the
  alpha was dropped, so the field re-syncs to show that.
- `means` (no expiry): the case may differ, but the alpha must match exactly. Otherwise a 6-digit
  text would hide a genuine external alpha change until the next blur.

Its test starts at a non-opaque alpha, because starting at 1 coincides with `alphaToByte(null)`
and cannot tell "any alpha" apart from "ff".

Rule for a new field: **never pre-round a `BufferedNumberInput`'s `value`. Pass `precision`.** More
generally, if a field's `value` is a projection of what it commits (rounded, re-cased, re-derived),
give `useBufferedValue` an `EchoMatch` that compares in that projection. When sweeping for this, grep
the VARIABLES too, not just `value={…toFixed…}`. The first sweep missed the Skin Editor's part
rotation and size (`rotDeg`/`wPx`/`hPx`), which were rounded into a `const` three lines above the
fields it did convert. A review reproduced that one committing a WRONG value: typing `12.3456`
stored 12.356.
Rounding inside `onChange` (Skin tessellate cols/rows, texture border) is different. There the field
really does reformat a fractional input, so a refusal is true.

Tests: `bufferedEcho.test.ts` § "at a display precision", `fields.test.tsx` § #1407 and
`colorFieldHex.test.tsx` § #1407. Seven
mutations were checked, each caught by its own test only.

### And the mirror-image trap: Escape, in a window that IS focused

The rule above is about a blur that never fires. The opposite state has its own bug, and the #233
close-out review caught it about to ship. A controlled input whose Escape handler reads

```tsx
else if (e.key === 'Escape') { setLocal(value); e.currentTarget.blur(); }   // ✗
```

**schedules** the revert and then blurs on the next line. In a genuinely OS-focused window that
`.blur()` dispatches *synchronously, inside the same handler*, before React has flushed anything —
so `onBlur` still sees the pre-Escape value and **commits the text the user just discarded**. The
field then repaints as reverted, so Escape looks like it worked while the garbage was already
persisted.

**Revert the DOM node first, and never commit from a state closure:**

```tsx
onBlur={(e) => commit(e.currentTarget.value)}                 // read the node, not a closure
onKeyDown={(e) => {
  if (e.key === 'Escape') {
    e.currentTarget.value = value;                            // synchronous — beats the blur
    setLocal(value);
    e.currentTarget.blur();
  }
}}
```

Now the trailing blur sees the reverted value and no-ops whichever order the two run in. An
**uncontrolled** field (`defaultValue` + a direct `e.currentTarget.value = initial` revert) was never
exposed to this — that is why `SkinEditor`'s `InlineNameField` is clean and the two controlled fields
were not.

**A test that stubs `blur()` to a no-op cannot see this class**, because it models only the unfocused
window. Editor field tests need BOTH: the non-dispatching stub for the #233 condition, and a stub
that really dispatches `focusout` for this one. See `textCommitField.test.tsx`.

### And a fourth shape: an undo SNAPSHOT (#244)

The three shapes above are all about the VALUE. A field can also hang something else off focus —
the Sprite Editor's slicer params took their undo snapshot in `onFocus` and pushed it in `onBlur`,
which is a fourth way for the same missing event to bite. With no focus events the value still
landed on every keystroke and **nothing reached the modal's history**, so ⌘Z reverted whatever step
came *before* the edit. Nothing errored, and the value looked right.

**The rule: open the session from `onChange` and close it on a signal that does not need focus.**
`editor/panels/coalescedEdit.ts` is the shared piece — `note()` snapshots lazily on the first change
since the last commit, an idle timer commits the run as ONE undo step, and `flush()` closes it from
anything else that touches the history.

Two consequences that are easy to miss:

- **`undo`/`redo` MUST `flush()` first.** This half of the bug does not need an unfocused window at
  all: type into a field and press ⌘Z without leaving it, and the pending snapshot is still
  un-pushed when the stack is popped. That is what makes it testable (see below).
- **Keep `onBlur` flushing** — it is the click-away path, and a *second* commit signal is free.
  What #244 was is `onBlur` being the ONLY one. In `SpriteEditor`'s `Num` it sits on the `<label>`
  rather than the input, because React's `onBlur` is `focusout` (it bubbles) and the shared
  `BufferedNumberInput` owns the input's own focus handlers.

The same change replaced that panel's bespoke `<input type="number">` with `BufferedNumberInput`.
A number input reports `value === ''` for an incomplete entry like a lone `-`, so with a
commit-per-keystroke field the sign was wiped before a digit could follow and a negative offset was
not typeable — the reason `fields.tsx` moved off `type="number"` in the first place.

### Testing this class: drive the field with no focus events

`engine/tests/e2e/editor-unfocused-field-commits.spec.ts` is the guard for #244 **and** for #242,
which shipped live-verified only. It is worth knowing why it looks the way it does.

Headless Chromium reports `document.hasFocus() === true`, and a second page does not change that
(measured) — so the unfocused state cannot be produced by window management. It is produced through
the EVENTS instead: dispatch `input` on the field through React's own value setter and never
dispatch `focus`/`blur`. The component sees exactly what an unfocused window gives it.

Three details are load-bearing, and a test that skips them passes against the broken code:

- **Append one character at a time, re-reading the field's value from the DOM each time.** If the
  field's own commit echoes back and rewrites the buffer mid-edit (#242), the next character has to
  land on the rewritten text — which is what a human typing into an unfocused window gets, and what
  pushing whole strings would hide.
- **Assert the STORE, not just the field**, wherever the display legitimately holds an
  unreconciled value (a clamped field shows `-3.5` while the store holds the clamp).
- **Never let the assertion race the coalescing window** (#300). Typing that way costs several CDP
  round-trips plus two rAF *per character*; in the full suite a gap stretched past the real 500 ms
  idle window, the coalescer correctly closed the step mid-run, and ⌘Z reverted to the intermediate
  `12` instead of `0` — about 1 run in 6, never in isolation. Forcing a 600 ms gap reproduces it
  100%, a 0 ms gap never does. Nothing was wrong with the coalescer: a human pausing 600 ms
  mid-number gets two undo steps too. So the spec widens the window past any plausible load via
  `__modokiEditorTest.setCoalesceMs()`, and says "the user paused" with
  `__modokiEditorTest.flushCoalescedEdits()` rather than sleeping for a timer.

  **Nothing is given up by that**, which is the part worth internalising: the timer's own behaviour
  ("a fast run stays one entry") is already pinned deterministically under `vi.useFakeTimers()` in
  `engine/packages/modoki/tests/editor/coalescedEdit.test.ts`. An E2E should only be buying what
  *only* a real browser can show — here the unfocused event delivery and a real ⌘Z flushing before
  it pops. Verified by mutation: the spec still fails if `undo()` stops flushing, and if a
  per-keystroke history returns.

  ⚠️ **The registry behind `flushCoalescedEdits()` is keyed on the SESSION, not on the edit
  object's lifetime**, and the difference is not cosmetic. Registering at construction and
  deregistering in `cancel()` reads as equivalent, but React StrictMode mounts → unmounts →
  remounts in dev: the unmount cleanup's `cancel()` fires once while the edit survives in a ref, so
  the session became unreachable forever and `flushCoalescedEdits()` silently saw zero. Joining in
  `note()` and leaving in `flush()`/`cancel()` also makes the set leak-free by construction.

### Remount a field when its TARGET changes

A field that tracks "is the user mid-edit?" in a ref must be keyed on what it edits. The ref is
cleared by a commit, so a target swap that never blurs the input — an agent changing selection over
MCP — leaves the previous target's typed text in place, and the next commit applies it to the NEW
target. The component cannot tell a target swap from an ordinary external value change, so the fix is
a React `key`, not more logic inside it.

Measured behaviour, the diagnosis, and how to reproduce it live: **[qa/knowledge.md](../qa/knowledge.md) §5**.

## Guards

Nothing structurally prevents the next ad-hoc `window.addEventListener('keydown', …)` — adding one
is the ergonomic thing to do when you want a panel shortcut, it is exactly how the original ten
accumulated, and it fails silently (the editor works, `verify` stays green, the key just fires from
the wrong panel). Two source-text tripwires stand in for that:

- **`engine/tests/editor/keymapOwnership.test.ts`** — no raw keyboard listener in `editor/**`
  outside an allowlist that must justify each entry. There are exactly **two** allowed: the
  dispatcher, and SceneView's Shift-snap, which tracks a modifier *level* (it needs keyup as much
  as keydown) rather than dispatching a discrete chord.
- **`engine/tests/architecture/modalShellCoverage.test.ts`** — no full-screen `position:fixed;
  inset:0` backdrop in `editor/**` outside the shell, except the two popover click-catchers
  (FontPicker, SpritePicker). A dialog that hand-rolls its backdrop registers no modal, and nothing
  else would notice. `modalDismissScope.test.ts` reads the shell's `onDismiss` for which dialogs may
  close on a backdrop press.
- The same file guards that every `scope:` literal names a real tier or panel id. `Scope` has an
  open `(string & {})` arm so a game can own chords, which means `scope: 'skin_editor'`
  type-checks, registers, and then never resolves — a silently dead shortcut tsc cannot catch.

## Gotchas

- **Synthesized input cannot answer "does the native menu swallow this?"** `sendInputEvent` — and
  therefore `modoki_press_key` and CDP `Input.dispatchKeyEvent` — reaches the renderer but does
  **not** trigger native Electron menu accelerators. Verified with a positive control (a bare `e`
  set `gizmoMode`, while ⌘R did not reload). So agent input and human input are on different paths:
  an agent can "verify" a chord that is dead for a human. That question needs a *physical* keypress.
- **A green jsdom test is not evidence that input works.** `fireEvent.mouseDown` synthesizes
  straight into React and cannot reproduce the real pipeline. `PanelFocusHost` shipped 7/7 green
  against an implementation that did nothing on the panels that matter most: canvas pointer
  handlers `preventDefault()` on pointerdown, which suppresses the *compatibility* mouse events, so
  `onMouseDownCapture` never fired. Fixed with `onPointerDownCapture` — but the lesson is that an
  input change must **also** be verified live (`modoki_tap` + `get_editor_state`/journal).
- **The dispatcher is bubble phase, deliberately.** A shell-level capture router would preempt five
  deliberate capture-phase claims and fire before `RenameInput`'s bubble-phase blanket
  `stopPropagation`, silently re-breaking inline rename typing.
- **Match the full chord, never `key` alone.** SceneView's modifier bail is what keeps bare `r`
  from eating ⌘R — a bug that was already fixed once.
- **Space arrives as `' '`.** Naive `'+'`-splitting erases it into the empty chord, which matches
  nothing with no error. `normalizeKeyName()` names it first.
- **`isTextEditable` is narrower than "any form control"** — a focused checkbox must not suppress
  ⌘Z, and a `readOnly` input is not editable. It must stay in sync with `keyboardSource`'s
  `editing()` and its duplicate in `rendererOps.ts`, or Enact's "focused editable will swallow
  this" warning lies.
- **The overlay stack pops by id, not top-of-stack**, and each hook instance gets its own owner via
  `useId()` — two instances of the same overlay kind would otherwise collide into a
  `KeymapConflictError`.
- **`display: contents` on `PanelFocusHost`** — it must add focus acquisition without adding a box,
  or every panel gains a layout shift.
- **HMR is untrustworthy for this code.** Hook order and listener registration change here, so a
  session that has absorbed a lot of HMR is not evidence either way — a correct fix measured four
  separate times as "not working" before a forced CDP `Page.reload` showed it working. Relaunch, or
  reload, before concluding anything.

## Related

- [editor.md](./editor.md) — the editor shell, panels, and undo/redo.
- [input.md](./input.md) — the runtime input seam the gate plugs into.
- [enact.md](./enact.md) — trusted input, selector aiming, and the fidelity question above.
- [debug-tools-mcp.md](./debug-tools-mcp.md) — `get_editor_state`, `editor_journal`, and the
  observe-don't-infer rule.
