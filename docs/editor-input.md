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
  `topOverlay`).
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
"New Project…" (`engine/electron/projects.ts:225`) and Assets' New Folder
(`editor/panels/Assets.tsx:1433`). With the **Assets panel focused**, a physical press creates a
folder and the New Project dialog does **not** open — single dispatch, Assets wins. Two things
this pins that the contract alone did not:

- It holds for a **raw DOM handler**, not just registry bindings — Assets' handler is
  element-scoped and outside the keymap (`TODO(P8)` at `Assets.tsx:1427`), yet its
  `preventDefault()` still suppresses the native accelerator.
- The outcome had been asserted twice from theory ("swallowed by New Project", then
  "double-fires") and **both were wrong**. It is also not answerable by tooling: synthesized
  input never reaches a native accelerator, and macOS focus-stealing prevention blocks an agent
  from raising the editor to send a real one. A human at the keyboard is the only instrument.

## Scope tiers

Five, resolved by priority. `resolve()` picks the highest-priority candidate for the chord.

| Tier | Fires | Members |
|---|---|---|
| `overlay` | only for the top of the overlay **stack**; outranks everything, so it may swallow an app-chord | Escape-to-close, the SpriteEditor modal's ⌘Z |
| `text-field` | when `document.activeElement` is text-editable | Enter/Escape commits, Backspace-clears-ref |
| `<panelId>` | only when that panel is focused, and never while text-editable | everything panel-specific |
| `app-key` | everywhere **except** text-editable | `f` (frame selected) |
| `app-chord` | everywhere, **text fields included** | ⌘S, ⌘Z, ⌘⇧Z, ⌘P |

The two-way split of "app" is the whole point: `f` must frame the selection from any panel, but
must not fire while you type "fog" into a name field. A panel scope is a **FlexLayout tab component
id** — `scene`, `game`, `hierarchy`, `inspector`, `console`, `assets`, `particle-editor`,
`animation-editor`, `timeline-editor`, `spriteanim-editor`, `skin-editor`, `ai`, plus any
game-registered id.

A command that logically belongs to more than one panel registers **once per scope** (Hierarchy's
selection commands are registered under both `hierarchy` and `scene`, so copy/paste works with the
viewport focused). Rename stays Hierarchy-only — the edit box lives on a row.

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
- **Observable as data** — `focusedPanel` is in `modoki_get_editor_state`, and a scope change
  journals `!focus {panel, from, to, source}` (on change only, never per keystroke). A focus ring
  that existed only as CSS would make "which panel owns keys?" a screenshot question, which
  [debug-tools-mcp.md](./debug-tools-mcp.md) forbids.
- **Drivable** — `modoki_press_key` and `modoki_focus` take a `panel` argument. The route fails
  loudly (400, naming the valid ids) when that panel isn't open, because a panel-scoped chord aimed
  at a closed panel is otherwise a silent no-op: the dispatcher just yields. `panel` and `selector`
  stay separate on `modoki_focus` — keyboard scope and `activeElement` are different questions.

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
- **Closing the gate resets held state**, on the closing edge. Hold `W`, click the Hierarchy, and
  the character must stop — otherwise `sample()` keeps reporting `w` held until physical release.
- **Null focus deliberately does not suppress**: pressing Play and immediately using WASD has to
  work without first clicking the GameView.
- The gate **fails open** if the policy function throws.

## Guards

Nothing structurally prevents the next ad-hoc `window.addEventListener('keydown', …)` — adding one
is the ergonomic thing to do when you want a panel shortcut, it is exactly how the original ten
accumulated, and it fails silently (the editor works, `verify` stays green, the key just fires from
the wrong panel). Two source-text tripwires stand in for that:

- **`engine/tests/editor/keymapOwnership.test.ts`** — no raw keyboard listener in `editor/**`
  outside an allowlist that must justify each entry. There are exactly **two** allowed: the
  dispatcher, and SceneView's Shift-snap, which tracks a modifier *level* (it needs keyup as much
  as keydown) rather than dispatching a discrete chord.
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
  reload, before concluding anything. (Also tracked in [todo.md](./todo.md).)

## Related

- [editor.md](./editor.md) — the editor shell, panels, and undo/redo.
- [input.md](./input.md) — the runtime input seam the gate plugs into.
- [enact.md](./enact.md) — trusted input, selector aiming, and the fidelity question above.
- [debug-tools-mcp.md](./debug-tools-mcp.md) — `get_editor_state`, `editor_journal`, and the
  observe-don't-infer rule.
