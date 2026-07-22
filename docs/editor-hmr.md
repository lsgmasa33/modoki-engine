# Editor hot reload (HMR) — what applies, what reloads, what can't

**Why this doc exists:** a stale editor doesn't just annoy — it makes **measurement lie**. Every
Percept read (`get_scene_state`, `journal`, `get_editor_state`) is only as trustworthy as the module
graph behind it, and the failure mode used to be **silent**. It cost two sessions: a correct sling
ramp fix was re-diagnosed and nearly reverted because the editor served the pre-fix build, and a
focus-scope fix measured four times as "not working" while the modules were stale.

Related: [editor-input.md](./editor-input.md) (the keymap contract), [debug-tools-mcp.md](./debug-tools-mcp.md)
(observe-don't-infer).

## The rules

| You edit | What happens |
|---|---|
| `games/<id>/**.ts`, `games/<id>/game.ts` (game **code**) | **Full page reload** — the only thing that can apply it |
| `games/<id>/runtime/assets/**` (scenes, prefabs, `.mat.json`, …) | No page reload; the **world** reloads via `modoki:scene-changed` |
| `games/<id>/tests/**`, `project.config.json` | Nothing (they don't affect the running editor) |
| `editor/input/{keymap,focusScope,dispatcher}.ts`, `editor/createEditor.tsx` | **Full page reload** (registry can't survive a swap) |
| `runtime/rendering/npr/**` | **Full page reload** (TSL nodes bake into compiled WGSL) |
| Any other engine/editor source | Normal React Fast Refresh |

## Why game code needs a reload

Vite **does** watch and recompile `games/<id>/**.ts` — this was long assumed otherwise. Measured via
CDP `Network.webSocketFrameReceived`: the update propagates up the static `virtual:modoki-games`
chain to `/app/App.tsx`, which is a Fast Refresh boundary and **self-accepts**, so nothing reloads.
Meanwhile the running editor got its game from a **separate** `@vite-ignore` dynamic import
(`app/projectGames.ts`, called once from `app/editor/setup.ts`) whose URL never changes — so ESM
keeps serving the cached instance forever. The new code is compiled, served, and never asked for.

Re-registering in place was evaluated and rejected — five things cannot be re-applied:

1. `registerAll()` is a guarded one-shot (`app/ecs/register.ts`).
2. `createEditor` returns a **new** component; `App.tsx` already resolved the old one via `React.lazy`.
3. `registerDebugCommand` is a plain array push — it duplicates on every re-run.
4. Engine systems register as a **top-level import side effect** (`app/ecs/pipeline.ts`).
5. `App.tsx`'s `GAMES` comes from the **baked** `virtual:modoki-games` — a different module instance
   than the editor's.

Also: `g.registerSystems()` is a silent no-op on a second call (games guard on a module-level
`registered` flag), and `registerSystem(name, fn, prio)` without re-passing `opts.actions` silently
unregisters every UIAction the previous registration owned. A full reload sidesteps all of it, and
matches what Open Project already does (`electron/main.ts` → `reloadIgnoringCache()`).

**Unsaved work: the reload wins, but never silently.** There is no `beforeunload` guard anywhere, so
the reload really does destroy unsaved scene edits. That is the deliberate choice — a stale editor is
the worse failure — but the loss is always announced:

- **Clean scene** → reload immediately.
- **Dirty scene** → a **5s countdown banner** ("reloading in Ns; unsaved scene changes will be
  LOST") with **Reload now** and **Cancel**. Doing nothing takes the loss.
- **After** such a reload → an info banner plus `discardedUnsavedEdits: true` in `get_editor_state`
  and a `!hmr.discarded-unsaved` editor-journal event. The discard happens on a page that is about to
  die, so it is carried across the reload in `sessionStorage` — otherwise it could never be reported.
- **Cancel** → `staleGameCode: true` and a persistent "Running STALE game code" banner. This is the
  one state where measurements silently lie, so it stays loud.

**If you are an agent, you are usually the cause**: your write to a game `.ts` is what triggers the
countdown, and the human may not be at the screen for it. Check `get_editor_state.unsavedChanges`
*before* editing game code and say so.

Implementation: `plugins/vite-asset-scanner.ts` (`isGameCodeFile` + `handleHotUpdate`) →
`modoki:game-code-changed` → `app/debug/hmrStaleness.ts`.

## The Fast Refresh trap: `[]`-deps effects do NOT re-run

Measured across one HMR cycle of a panel:

| | before | after |
|---|---|---|
| module re-evaluated | 3 | **4** |
| component re-rendered | 2 | **4** |
| `[]`-deps effect re-ran | 2 | **2** |

So a panel that registers into a module-level registry from a `[]` effect keeps its **original**
registration forever. Handler *bodies* still update (they're reached through a ref that every render
refreshes), which is why this looks like it works — what goes stale is registration **structure**:
adding a binding, or changing its `keys`/`when`.

**If you add a registry-writing effect, key it on `useHmrEpoch()`** (`editor/input/hmrEpoch.ts`),
which ticks on every hot update and is a frozen `0` in production — so `[epoch]` is exactly today's
`[]` in the packaged editor. All eight keymap registrars already do this.

## Registries that force a reload instead

`keymap.ts` was measured forking into **two live registries**: after an edit the new instance held 24
app bindings and **zero** panel bindings, while the window dispatcher kept resolving against the old
instance. `invalidate()` (the NPR precedent) is not enough there — the importers are panel
*components*, which are valid refresh boundaries and absorb the propagation. Those four modules use
`import.meta.hot.accept(() => location.reload())` instead. They are stable files, rarely edited.

**Most module-level state does NOT need this.** A 50-agent audit found 341 module-level bindings,
claimed 153 as risky, and only **6** survived adversarial verification. The reason most are safe is
worth knowing: Vite propagates an update through the whole importer chain to the nearest
self-accepting boundary, so a registry and its writers are almost always recreated **together**. The
broken shape is narrow — a registry in a non-boundary module whose writers are `[]`-deps effects
inside components that *are* boundaries. Don't add `import.meta.hot` handling on suspicion; establish
that shape first.

## Unrecoverable Fast Refresh

Changing **hook order** (adding/removing a hook) throws *"Rendered more hooks than during the
previous render"* inside Fast Refresh and takes down mounted panels via their error boundaries. This
is inherent to React, so `app/debug/hmrStaleness.ts` **detects and reloads** rather than trying to
prevent it — once only, guarded by a `sessionStorage` key so a crash that reproduces on boot cannot
loop. If you see the reload happen twice, the edit has a real defect; it is not an HMR artifact.

## Checking whether an editor is stale

`get_editor_state` reports `hmrUpdates` (hot updates since boot; absent means zero),
`staleGameCode: true` (a game-code reload was cancelled — this editor runs the OLD build), and
`discardedUnsavedEdits: true` (this page load dropped unsaved scene work to pick up new game code).
Silence on all three means the running build is the one that booted and nothing was lost.

Plugin changes (`engine/plugins/**`) are **not** hot-reloadable at all — restart the editor
(`npm run editor:ai`) after pulling or editing them.

## This applies to the PACKAGED editor too

Easy to get backwards, and the code comments originally did. The packaged editor **spawns a real
Vite dev server and loads its origin** (`electron/devServer.ts`: *"the packaged app == the dev app
(one Vite origin)"*), so `import.meta.hot` is **defined** there and everything on this page — the
game-code reload, the countdown, the epoch, the crash recovery — is live for DMG users. That is
deliberate: the packaged editor is a real authoring environment where people edit game code.

What genuinely has no HMR is a shipped **game** build (web/native/playable): `__MODOKI_EDITOR__` is
false, so `main.tsx` never imports `hmrStaleness` at all, and `useHmrEpoch()` is a frozen `0` making
`[epoch]` identical to `[]`.

**Known scope limit:** the four `accept(() => location.reload())` modules and the hook-order recovery
reload do **not** run the unsaved-work countdown — they reload immediately. They live in the engine
package, which cannot import the app-shell guard. In practice they fire only when you are editing
those specific engine files, not while authoring a scene.
