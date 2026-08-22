# API Reference (generated)

The generated API reference (`modoki-engine.com/docs/api/`, TypeDoc →
`typedoc-plugin-markdown` → `typedoc-vitepress-theme`) is a **lookup surface**, reached by search
("I know the name, show me the signature") — the browsing entry point is the hand-written guide
(`site/docs/guide/`) and reference (`docs/*.md` → `/docs/reference/`). Setup lives in
`typedoc.json` + `typedoc-category-by-folder.mjs`; the sidebar is post-processed at config-load
time by `site/.vitepress/config.ts`.

## The problem this solved

TypeDoc documents whatever is exported, and `@modoki/engine`'s barrel (`runtime/index.ts`)
re-exports 877 distinct symbols from 140 modules at equal visual weight — unrankable, and the
old flat categories (`Core / ECS` 202, `Loaders & Assets` 152, …) were dumping grounds that
didn't correspond to any real concept. Root cause was never TypeDoc's categorization scheme; no
scheme makes 877 undifferentiated symbols browsable.

## The decision that shaped the work: nothing gets hidden

"Public" conflates two things, and only one has a cost:

1. **Contract** — "I promise not to break this."
2. **Prominence** — "this is what you're looking for."

The cost of #1 scales with how many people depend on the symbol. `@modoki/engine` is `0.1.0`,
not on npm, and games resolve it through the editor — declaring the whole surface public costs
~nothing today, and a restrictive surface has its own cost (pushes users to fork or reach into
internals, the way three.js's near-total export surface does). **So everything stays exported and
documented; the tiering is purely editorial** — an "Essential" whitelist that ranks the surface
without hiding anything unlisted (unlisted symbols simply fall to the full A–Z index). This is
what makes the whitelist cheap: no "is this public API?" judgment per symbol, mis-tiering costs
nothing (still documented, still linked, still in search), and no guard test is needed (a new
export can't break the surface, it just lands in the full index).

Deferred, not lost: `excludeInternal: true` is already set, so if external users ever appear the
same manifest is the mechanism for drawing a real contract line.

Two mechanical shortcuts were considered as *seeds* for the whitelist and were weak on their own
— recorded so they aren't re-tried as classifiers: **game/demo usage** (177 project `.ts` files
import only 139 of the 877 symbols; the sample projects are small and skew old) and **machinery
naming** (`*System`/`register*`/`dispose*`/`acquire*`/`*Impl`/`*Cache`/… matches 112, with 22
false positives — game `setup.ts` legitimately calls `registerTrait`, `acquireMesh`, etc.).
Together they leave 648 ambiguous — fine as hints for seeding the editorial whitelist, useless as
classifiers.

## Shipped shape

Per category in the sidebar:

```
Physics
  Essential            (curated, expanded)   RigidBody3D, Collider3D, raycast, …
  Traits               (collapsed)           the remainder, grouped by kind
  Functions            (collapsed)
  Interfaces           (collapsed)
  Types                (collapsed)
```

Plus one flat **All exports (A–Z)** section per module, built from the pre-split sidebar so it
needs no new page/component — reusing the already-generated per-symbol pages plus VitePress's
existing local search (`search: { provider: 'local' }`).

All four phases landed:

- **Kind-subgrouped sidebar** — `splitByKind()` in `site/.vitepress/config.ts` post-processes
  `site/docs/api/typedoc-sidebar.json`, grouping each category's items by the kind segment
  already encoded in `typedoc-plugin-markdown`'s link paths (`interfaces/`, `functions/`,
  `variables/`, `type-aliases/`, `classes/`); a category with only one kind stays flat.
- **Managers document their methods** — the 3 manager singletons with real game-facing methods
  beyond `ManagerDef` lifecycle (TimeManager, NavigationManager, SceneManager) each export a
  public interface and are typed against it instead of the bare `…Impl` class. The other 6
  manager singletons (`inputSourcesManager`, the physics/timeline/zone event-bus managers) turned
  out not to need this — they're plain `ManagerDef` object literals with their real API exposed
  as a separately-exported, already-interface-typed sibling (`physics2DEvents: PhysicsEventBus`,
  etc.).
- **The Essential whitelist** — `docs/api-essential.json`, 159 unique symbol names across 19
  human-readable groups, seeded from the guide's vocabulary plus the game/demo-usage scan above;
  checked by symbol name alone, so the grouping doesn't have to match the TypeDoc category a
  symbol actually renders under. `splitEssential()` in `site/.vitepress/config.ts` does a second
  independent post-processing pass over the generated sidebar (same technique as the kind-split
  above) rather than a new `@category`-style TypeDoc tag — a category with essential members gets
  an expanded "Essential" bucket followed by the existing collapsed kind-groups built from the
  remainder.
- **Recategorize** — `Core / ECS` (202) and `Loaders & Assets` (152) were replaced by 8 new named
  categories sized comparably to the existing good ones (all ≤67): `ECS Core`, `Time &
  Determinism`, `Play State & Preview`, `Game Definition & Services` (where `AdsService` /
  `AttributionService` / `CrashlyticsService` now correctly land), `Debug & Journal`, `Materials,
  Shaders & Textures`, `Resource Cache` (the refcounted acquire/release subsystem CLAUDE.md
  documents as load-bearing, named for the invariant rather than the folder), `Assets & GUIDs`.
  Mechanism: `typedoc-category-by-folder.mjs`'s `FILE_CATEGORIES` second-segment override table,
  consulted only for `core/`/`loaders/` — every other top-level folder resolves as before.
  Nothing moved on disk; this is pure category-label engineering, and `typedoc.json`'s
  `categoryOrder` was updated to match.

## Open questions

- Should `@modoki/engine/editor` and `@modoki/engine/three` get API pages at all? Currently only
  `runtime` + `runtime/rendering` are entry points, but games do import from both (7 and 3
  symbols respectively).
- Is a middle "Advanced" tier worth adding later if `Essential` + kind-grouped remainder proves
  too coarse? Deliberately deferred — two tiers first.
