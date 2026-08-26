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

## Measured: no editor registry subscription needs `hmrEpoch` (#312)

Panel effects that subscribe to a module-level listener `Set` with `[]` deps are exactly the broken
shape above, so they were **measured rather than patched**. Every one is safe, and none needed a
change. The reason has nothing to do with the effect's deps.

The unit of measurement is the **registry module**, not the site — a fresh `Set` can only appear if
that module is re-evaluated while the subscriber survives. Touching each one:

| Registry module | Touched → | Subscribing sites |
|---|---|---|
| `runtime/core/ecs/worldRegistry.ts` (`onWorldSwap`, via the `ecs/world.ts` re-export) | **page reload** | `SceneView.tsx` :356 :2470 :3592 · `Hierarchy.tsx` :603 :625 :743 · `TimelineEditor.tsx` :563 |
| `runtime/core/renderDirty.ts` (`addDirtyListener`, re-exported unchanged from `entityUtils.ts`) | **not independently re-measured** — moved out of `entityUtils.ts` (side-effect-free extraction, matching `uiDirty.ts`'s own split off `uiTreeStore.ts`); touching `renderDirty.ts` alone now resets this Set, touching `entityUtils.ts` alone may no longer | `Console.tsx` :63 · `Hierarchy.tsx` :742 · `SceneView.tsx` :2468 |
| `runtime/core/ecs/entityUtils.ts` (`onStructureDirty`, `onStructureDirtyCoalesced`) | **page reload** | `SceneView.tsx` :2469 |
| `runtime/core/uiDirty.ts` (`onEditorDirty`, via `runtime/ui/uiTreeStore`) | **page reload** | `inspectorFields.tsx` :23 · `Inspector.tsx` :1633 · `UIFocusGraphOverlay.tsx` :143 · `UIResizeOverlay.tsx` :267 |
| `runtime/core/activeRenderer.ts` (`onRendererLost`) | **page reload** | `SceneView.tsx` :4736 |
| `runtime/core/playState.ts` (`onPlayStateChange`) | **page reload** | `SceneView.tsx` :2471 |
| `runtime/rendering/text/textDirty.ts` (`onTextDirty`) | **page reload** | `SceneView.tsx` :2472 |
| `runtime/rendering/materialDirty.ts` (`onMaterial3DDirty`) | **page reload** | `SceneView.tsx` :2478 |
| `editor/animation/poseClip.ts` (`onPoseEnvelopeExited`) | **page reload** | `AnimationEditor.tsx` :439 — see below |
| *control:* `editor/panels/Console.tsx` | `hmr update` | — |

A full reload rebuilds the registry **and** its subscribers together, so the stale-`Set` fork cannot
happen. **The control is the load-bearing row**: without one module that genuinely stops at a
boundary, "page reload everywhere" is indistinguishable from a probe that cannot see the difference.

**Re-running the sweep** (the site list above is a snapshot; this query is not):

```bash
cd engine/packages/modoki/src
grep -rn --include='*.tsx' -E "useEffect\(\(\) => on[A-Z]" editor      # inline-return form
grep -rn --include='*.tsx' -E "(=|return|\[)\s*on[A-Z][A-Za-z]*\(" editor | grep -vE "\bon[A-Z][a-z]*="
```

Then, per registry module, in a running editor: stamp `window.__hmrProbe` via `modoki_eval`, append
a comment to the module, re-read the probe. Gone (and `performance.timeOrigin` advanced) → full
reload, site is safe. **Surviving → the update stopped at a component, and that site needs
`useHmrEpoch()`.** The vite log (`page reload …` vs `hmr update …`) agrees but is not sufficient
alone — read the probe.

**`poseClip.ts` is the row to understand, because it is why #312 was filed.** It is imported by
`AnimationEditor.tsx`, a component Fast Refresh accepts — the textbook broken shape. It still
full-reloads, because **`editor/index.ts` imports it too**, and that barrel is a non-component
module with no accepting boundary above it. Vite full-reloads when *any* propagation path fails to
find one. The barrel re-exports nearly the whole editor surface, so almost every editor and
`runtime/core` module inherits a non-accepting path to the root — **that is what makes this bug
class unreachable in practice**, and it is why the keymap registries needed an explicit
`location.reload()` while these do not (they are reached only through component importers).

So #312's premise that the hazard "just bit for real" is **wrong**: the `useHmrEpoch()` key added to
`AnimationEditor` in `9c6215f35` is harmless and costs nothing in a shipped build, but it was never
load-bearing. Do not read it as evidence the hazard fired.

⚠️ **This verdict is a property of the import graph, not of the effects.** It would stop holding if
a registry module's only importers became components — so re-measure with the query above after a
refactor that narrows one, rather than trusting this table.

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
