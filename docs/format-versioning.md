# Format versioning — one pattern for every versioned document

Modoki persists a lot of documents: scenes, prefabs, asset sidecars, manifests, OTA releases, player
saves. Most of them carry a `version` or `schema` number. This doc is the **single design for all of
them** — what the number means, who reads it, and what happens when a build meets a document newer
than it understands.

It exists because that question was answered **five times, four different ways**, before anyone wrote
it down. #630, #734, #730 and #629 each fixed one instance and each invented its own shape. The fix
rate was never the problem — the absence of this page was.

#767 and #778 then closed the two data-loss instances and, in doing so, found *why* the shapes kept
diverging: the **verdict** and the **disposition** were being computed in one expression (§ 2). Both
now come from one place — `runtime/core/formatVersion.ts` for the verdict, § 2b-bis for the choice.
**Four documents were unfixed** — `.particle.json`, `.atlas.json`, `.mesh.json`/`.mat.json` and the
profiler capture export — plus scene's disposition and prefab's recorded non-gate; they are #784, and
they are one piece of work with one design, not one ticket each. Phase C2a (`.particle.json`,
`.atlas.json`), C2b (`.mesh.json`, `.mat.json`) and C3 (scene's disposition, prefab's recorded
non-gate confirmed) have landed; the profiler capture export is covered by its own row in § 3.

## 0. Three kinds of version, and they are not interchangeable

Getting this wrong picks the wrong failure behaviour, which is exactly how it went wrong once
already (a rule reasoned from `engineApi`'s precedent and applied to a field that is not that kind).

| Kind | Answers | Compared against |
|---|---|---|
| **Format** | how is this document laid out? | a constant compiled into the **reader** |
| **Data / identity** | which payload is this, and is it newer? | what the caller **requested**, or what is installed |
| **Compatibility** | what does this content need **from the host**? | the host's own capability |

The OTA per-bundle manifest carries all three at once — `{schema, name, version, engineApi, files}` —
which is the cleanest available proof they are three different things and not three spellings of one.

**This document is about the FORMAT kind.** For the other two: `engineApi`/`minEngineApi` are the
compatibility kind and already work; `manifest.name`/`.version` and `release.seq` are the
data-identity kind, covered in [ota-updates.md](./ota-updates.md).

## 1. The rule

> **A build that meets a document stamped with a version it does not understand must not destroy it.**
> Read defaults, carry on, and leave the bytes alone.

Owner's ruling, settled on #630 and applied to every document since. The corollary that is easy to
miss and is where the real damage lives: **not destroying it means not writing your own version over
it either.** A reader that merely fails to *understand* the document is harmless; a writer that
re-stamps its own number onto a document it could not read has silently thrown away the one signal a
future migration needs.

## 2. The four contracts

The reason five sites produced five shapes is that only ONE of the four parts legitimately varies —
the channel. (This section described *three* contracts until #767/#778 established that the
disposition is a fourth, and a bounded choice rather than something each site invents.)

⚠️ **The reason it kept happening: every site fused the VERDICT with the DISPOSITION.** *What is
this document relative to my build?* and *what do I do about it?* are two questions, and each site
answered both in a single boolean expression — so each re-derived both, and each collapsed whichever
verdicts its chosen disposition happened not to need. **The collapse is the damage**, not the
comparison: once `absent` and `unreadable` are the same answer, the write path can no longer tell a
document that is safe to replace from one that must be preserved, which is exactly how #778
destroyed authored sidecar fields while reporting success. Measured across all eight sites: eight
different collapses, one correct comparison, one union shape, and no site with both.

So the parts are: the **verdict** (§ 2a, shared and total), the **disposition** (§ 2b-bis, a bounded
choice per document), the **stamp** (§ 2b, shared), and the **channel** the disposition speaks
through (§ 2c, local).

### 2a. Classification — SHARED, and identical everywhere

**Implemented once, in `runtime/core/formatVersion.ts`** (`classifyFormatVersion` /
`classifyJsonFormatVersion`). Given a raw parsed document and this build's constant, the verdict is
one of:

| Verdict | Meaning | Because |
|---|---|---|
| `ok` | at or below this build's version, at or above its floor | readable, possibly after a migration |
| `too-new` | strictly greater | structurally intact, semantically unknown — **protect it** |
| `too-old` | below the caller's `minReadable` floor | a deliberate, bounded refusal to read |
| `absent` | no `version` field | legacy or freshly created — readable |
| `unreadable` | did not parse, not an object, non-integer version | corrupt — replace only after preserving it |

⚠️ **`too-old` is a fifth verdict, and it is not a refinement.** A `MIN_READABLE_*` floor is a
*decision not to read* something this build understands the shape of; `unreadable` is *damaged
bytes*. They call for opposite handling — one is policy, the other is corruption — and folding them
together rebuilds the verdict/disposition fusion described below. `wordweave`'s
`MIN_READABLE_PURCHASES_VERSION` needed it before this doc existed, and the IAP ledger needs it now.

⚠️ **`too-new` and `unreadable` must be different answers**, and this is the precondition, not a
refinement. #630's protection was literally unreachable until `readEnvelope` stopped returning
`undefined` for both — see [[null-conflates-absent-with-unknown]]. Any site that collapses them
cannot implement the rule in §1, because the write path cannot tell an entry that is safe to replace
from one that must be preserved.

⚠️ **Strictly greater only.** Absent, older, zero and non-numeric all read normally. A `>=` here
refuses every document including the ones this build just wrote.

### 2b. Stamping — SHARED

**The module that owns the format owns the number.** Writers do not supply a version; the write
helper stamps the constant. Two consequences worth stating because both were violated:

- **Never write a numeric literal.** With no named constant there is nothing for a reader to compare
  against and nothing for a reviewer to find — that is the precondition every unfixed instance shares.
- **Never echo back what you read.** Copying the stored version forward looks conservative and is how
  a document ends up claiming semantics the writing build does not implement (#763's defect).
  `Math.max(stored, current)` has the same trap and needs the same audit.

A writer that cannot route through the shared helper must do **both** halves itself — stamp *and*,
if it can overwrite an existing document, refuse a `too-new` one. Doing only the refusal produces an
unstamped document, which is the same defect wearing a different face; that exact mistake shipped
once and was caught in review.

### 2b-bis. The disposition — a bounded choice, declared per document

What a `too-new` document *deserves* is a property of the DOCUMENT, and there are exactly two
answers. This is the part that was never written down, which is why every site invented one.

| Disposition | For | On `too-new` |
|---|---|---|
| **REFUSE** | machine-generated artifacts that are a unit — sidecars, manifests, OTA releases, sub-game bundles | do not read, do not write; the bytes stay untouched |
| **PRESERVE** | documents holding the player's own data — PlayerPrefs documents, saves, the IAP ledger | read the known fields, carry the unknown ones through, write back `max(stored, current)` |

⚠️ **"Warn and load anyway" is not a third disposition — it is the absence of one.** The scene
loader used to do exactly that (`loadSceneFile` logged that the file was newer than this engine
supported, then loaded it and let the ladder re-stamp an absent version) — it read a document it
had just admitted it did not understand, and then wrote. **Fixed in #784 phase C3**: Scene's
disposition is now REFUSE (§ 3's row), the same as every other machine-generated artifact.

Choose by asking **what refusing costs the player.** Refusing a sidecar costs a reimport; refusing a
save costs someone their purchases, so a save is never REFUSE. Both honour § 1's rule — REFUSE by
not writing at all, PRESERVE via `preservedVersion` — and both are subject to the same invariant:
**never stamp your version onto a document you could not fully read.**

PRESERVE additionally needs the unknown-field bag (`collectUnknownFields` / `mergeUnknownFields`,
same module). ⚠️ **Do not hand-roll it.** `wordweave` rolled it twice, in the same game, and review
still caught a real defect in the second one (#763).

### 2c. The refusal channel — LOCAL, deliberately

This is the part that legitimately differs, and pretending otherwise would make this a bad
abstraction. What a site does with a `too-new` verdict is dictated by its caller's error vocabulary:

| Site | Channel | Why that one |
|---|---|---|
| `.meta.json` sidecar | **throws** | a human just triggered a reimport in the editor and is watching |
| PlayerPrefs | **warns, refuses the write** | a save read at boot with nobody watching |
| sub-game loader | **`notEvidence` disposition** | must not quarantine a bundle the next engine build would run |
| OTA client | **outcome union** | the caller decides whether to surface, retry or ignore |

What must be uniform is the **verdict** and the **decision table in §3** — not the plumbing. A new
document picks a channel that fits its caller and records the choice in that table.

## 3. The decision table — every versioned document in the repo

The corpus. A new versioned document adds a row here in the same change that introduces it.

| Document | Constant | Disposition | Reads it? | On `too-new` |
|---|---|---|---|---|
| PlayerPrefs envelope | `SCHEMA_VERSION` (`runtime/storage/playerPrefs.ts`) | PRESERVE | ✅ | protected; `set()` warns and refuses |
| `.meta.json` sidecar | `SIDECAR_FORMAT_VERSION` (`plugins/meta-sidecar.ts`) | REFUSE | ✅ | throws; reimport aborts per asset |
| `subgame.json` | `SUBGAME_MANIFEST_SCHEMA_VERSION` (`runtime/core/version.ts`) | REFUSE | ✅ | `notEvidence` |
| `assets.manifest.json` | `ASSET_MANIFEST_VERSION` (`runtime/loaders/assetManifestVersion.ts`) | REFUSE | ✅ | `notEvidence`, checked **before** the merge |
| OTA `manifest.json` / `release.json` | `SCHEMA_VERSION` ×2 (`runtime/ota/otaClient.ts`, `scripts/ota/schema.mjs`) | REFUSE | ✅ | refused; parity test pins the two constants |
| Scene | `SCENE_FORMAT_VERSION` (`runtime/core/version.ts`) | REFUSE | ✅ | classified at **two** sites, deliberately: in `SceneManager.loadScene`'s pre-load loop (the only production entry, and the one that must run before `collectSceneResourceRefs` — see § 4's fourth trap) and again at the top of `loadSceneFile` as the backstop for direct callers, both through the same `classifyFormatVersion` and the same `SceneFormatRefusedError` so they cannot disagree. Ahead of the migration ladder and of the two mutators (`assignSyntheticEntityIds`, `stripLegacyCameraFrameShowGizmo`) that used to run on it unconditionally — a `too-new`/`unreadable` document is now refused (throws `SceneFormatRefusedError`) before either can touch it, bytes untouched, no entities spawned. **`absent` is deliberately NOT refused** — a genuinely pre-v3 scene has no `version` key at all and still runs the whole ladder; that is § 2a's "legacy — readable" verdict, not an oversight. The throw lands in `SceneManager.loadScene`'s own failure path (release + destroy `nextWorld`, no `setCurrentWorld`), so the previously-active scene is untouched. The editor's `loadScene()` wrapper (`editor/scene/serialize.ts`) surfaces it as a distinct `'refused'` outcome — toasted (`showToast(…, 'warn')`) and logged, not folded into `'failed'`, because "check the path" is a wrong diagnosis for a right symptom — and `agentEditorOps.ts`'s `load-scene` op carries the real reason instead of guessing one (#784 phase C3) |
| Prefab | `PREFAB_FORMAT_VERSION` (`editor/scene/prefab.ts`) | — | ⚠️ **raises only** | nothing branches — a writer-only stamp, confirmed, not a gate to be invented (#365) |
| IAP ledger / mock store | `LEDGER_FORMAT_VERSION` / `MOCK_STORE_FORMAT_VERSION` (`runtime/iap/`) | PRESERVE | ✅ | read + bagged; `max(stored, current)` on write-back (#767) |
| `.particle.json` | `PARTICLE_FORMAT_VERSION` (`runtime/particles/types.ts`) | REFUSE | ✅ | not cached (`particleCache.ts`'s permanent `failed` set), logged at **error** — a "still loading" `null` and a "refused forever" `null` are otherwise identical to every consumer. `ParticleEditor` refuses to open it, disabling editing rather than substituting `defaultParticleEffect()` and marking it the saved baseline — which was #778's mechanism on this document (phase C2a) |
| `.atlas.json` | `ATLAS_FORMAT_VERSION` (`runtime/loaders/spriteAtlas.ts`) | REFUSE | ✅ | the panel's existing `loadState` gate, as a **distinct `'refused'` state** — same disabled editing as a load failure, different banner, because "Could not load — Retry" is a wrong diagnosis for a right symptom. `reimport-atlas.ts` throws a named verdict into the three contexts that already handle a throw (build fails red, dev repack collects a per-asset error, `modoki_import_file` returns 422). The `version: 1` that `serializeAtlasDoc`'s own unknown-key preservation was clobbering is gone (phase C2a) |
| `.mesh.json` | `MESH_FORMAT_VERSION` (`runtime/traits/Renderable3D.ts`) | REFUSE | ✅ | not cached (`meshTemplateCache.ts`'s `MESH_FAILED`, matching the particle/atlas shape); read-before-write in `modelImport.ts` ABORTS the import via `ImportWriteAborted` rather than minting a fresh GUID over it (#784 phase C2b) |
| `.mat.json` | `MATERIAL_FORMAT_VERSION` (`runtime/traits/Renderable3D.ts`) | REFUSE | ✅ | not built (`meshTemplateCache.ts`'s `MATERIAL_FAILED`, same fallback the "unknown material type" branch already used); read-before-write in `modelImport.ts` ABORTS rather than minting a fresh GUID. The two-writer divergence (B1) is fixed here too — `defaultMaterial()` (`runtime/assets/assetSchemas.ts`, reached by BOTH GLB import's `extractMaterialAsset` and the "Create Material" button via `defaultAssetData`) now stamps the constant from one place. The **11 pre-existing versionless `.mat.json`** (10 under `games/sling/`, 1 `demos/forest-camp/.../pond_water.mat.json`) are left untouched — they remain valid, readable documents under the `absent` verdict (§ 2a); this phase does not re-stamp them |
| `.rig2d.json` | — no field at all | — n/a | ❌ | never had a format version; the SHAPE (`parts[]` present or not) is the v1/v2 discriminator, and code never reads/writes a `version` key. The schema row that advertised one was an unread authoring surface — removed here (#784) |
| Profiler capture export | — dropped in this change (#784) | — n/a (pure sink) | n/a | one-way debug export; nothing re-ingests it, so a version here would guard nothing (§ 1) |

**Not in this family, despite the name.** `Skin2DBuffer.version` is an in-memory GPU-upload dirty
counter, never serialized (see the warning below). `sync/decide.ts`'s `version` is a **data-identity**
version — a compare-and-swap revision, § 0's middle row — not a format version. Both are excluded
from the § 4 guard by name, with those reasons.

† **`.particle.json` had two more sites assuming the constant stays `1`; phase C2a moved both.**
`assetSchemas.ts`'s `validateAssetData` warns `'particle.version should be 1'` on `obj.version !==
1` — a `!==`, so it flags a legitimately NEWER document exactly as loudly as an older one, violating
§ 2a's strictly-greater rule (it is advisory only, so nothing is refused, but it will warn on every
particle document written the moment the constant moves past `1`). `PARTICLE_FIELDS` declares the
field itself as `{ key: 'version', type: 'number', default: 1, note: 'always 1' }` — the note tells
an authoring agent the field is meaningless, and `default: 1` marks it a strip candidate the moment
someone reads § "Author values in the SCENE and the PREFAB". **Both had to move in the same change
as the constant** — landing `PARTICLE_FORMAT_VERSION` without them would have shipped a constant
beside two committed statements that it is wrong. The check now routes through
`classifyFormatVersion` and warns only on `too-new`; the field's row no longer claims "always 1"
and no longer carries a `default`. Kept as a footnote because the *shape* recurs: a schema note or
an advisory validator is a second, quieter copy of the constant, and neither is where anyone looks
when bumping one.

The unfixed rows are tracked as **one piece of work with one design, not one ticket each** — #784.
If that work gets split, split it by RISK, never by document.

⚠️ **`Skin2DBuffer.version` is NOT in this family.** It is an in-memory GPU-upload dirty counter that
`Scene2D` compares to decide whether to re-upload a buffer. It is never serialized. It is a version
check that already works, and the resemblance is nominal.

## 4. Two traps a guard in this area walks into

Both were hit while fixing this family, in opposite directions, and neither is visible to a green run.

- **A guard STEERS the fix.** A guard that flags a *token* makes deleting the token the cheapest way
  to go green — and the token may be the only thing doing the work. The `formatVersionFromConstant`
  guard flagged `version: 2` in a writer where that literal was the sole stamp; deleting it satisfied
  the guard and reintroduced the defect. **Require the replacement, not merely the absence.**
- **A guard's ANCHOR can be the thing you deleted.** `metaMergeNotClobber` locates meta-write literals
  by searching for `version:\s*\d`. Once the writers stopped needing that literal it became inert but
  load-bearing, and removing one made its file invisible to the guard. **Anchor a detector on the
  structural thing (the write call), never on a value another change can legitimately remove.**

Mutation-check both directions: break it the way a careless *fix* would, not by deleting the
mechanism.

**A third trap, found while closing #778: preserving the BYTES is not preserving the ASSET.** The
first cut of that fix moved a corrupt `.meta.json` aside and felt complete — the authored fields
were all still on disk. But the sidecar also carries the asset's GUID, and every path that had just
failed to parse the file went on to treat it as *un-stamped*: the editor panels read `{}` through
`/api/read-meta` and POSTed a payload with no `id`, and the scanner's `readAssetGuid` returned
`undefined`, so the heal pass minted a fresh GUID and every scene/prefab reference dangled. The
authored fields can be merged back by hand at leisure; a re-minted GUID silently breaks working
content. **A recovery step has to ask what the file IDENTIFIES, not only what it contains** —
`salvageSidecarId` now reads the `id` textually out of the damaged bytes (a merge conflict wraps
only the conflicting hunk, so that line is nearly always intact) and refuses to guess when the id
itself conflicts.

**A fourth trap, for the corpus inversion planned in #784 item 2 (making § 3's table itself a
derivable source of truth): don't turn a constant into a registry lookup without moving the guard
that pattern-matches its literal.** `prefabFormatVersionLiteral.test.ts` (landed on `origin/main`)
keeps `PREFAB_FORMAT_VERSION` in sync with a deliberate numeric literal in the Playwright spec
`editor-hierarchy.spec.ts` — the two drifted 2 → 3 and only the free public e2e runner caught it,
since e2e isn't in `npm run verify`. It locates the constant with `PREFAB_FORMAT_VERSION\s*=\s*(\d+)`;
a refactor to `export const PREFAB_FORMAT_VERSION = FORMAT_VERSIONS.prefab` no longer matches. Credit
where due: that guard asserts its match exists before comparing, so a broken anchor fails loudly by
name rather than passing vacuously — § 4's own "anchor" lesson, applied correctly.

**A fifth trap, and it defeated this family's own guard once: a classifier is only as good as
everything UPSTREAM of it.** C3 put the scene verdict at the top of `loadSceneFile`, argued in its
own comment that this was the single entry every path funnels through, and shipped green — but
`SceneManager.collectSceneResourceRefs` ends with `sceneData.version = Math.max(sceneData.version ??
6, 6)` and runs *earlier*, on the same object. `Math.max` numerically coerces, so `"5"`, `"13"`,
`2.5` and `null` all reached the guard as a clean `ok`: the entire `unreadable` half of the
disposition was dead in production, while a unit test calling `loadSceneFile` directly proved it
worked. **Ask what mutates the document between the bytes and your verdict** — and prefer to
classify where the bytes are first parsed, not where they are first used. The test that would have
caught it is the one driven through the real caller; the one that did not is the one that called
the classified function directly.

⚠️ Related, still unfixed and filed separately: that same `Math.max` also RAISES an older numeric
version to 6, so a genuine v3 scene is stamped 6 and skips the v3→v6 rungs entirely. Latent only
because the committed corpus bottoms out at v9.

⚠️ **And a non-trap, recorded because it was written down as fact first.** That fix also claimed
the quarantine file would be scanned as an asset unless its suffix was explicitly skipped, reasoning
from `.meta.local.json`, which genuinely needed that. It is false: `.meta.local.json`'s extension is
`.json` and hits the JSON branch, whereas `.corrupt` falls through `EXT_TYPE[ext] || null` and
classifies as a non-asset with or without the clause. Measured by passing a bare `.corrupt` path the
clause does not match and getting `null` anyway. The clause stays as belt-and-braces; the claim that
it is load-bearing does not.

## 5. Adding a new versioned document

1. Declare a named exported constant in the module that owns the format. Never a literal.
2. Classify on read by **calling `classifyFormatVersion`** (or `classifyJsonFormatVersion` when you
   are reading bytes) from `runtime/core/formatVersion.ts`. Do not hand-roll the comparison — every
   hand-rolled one in this repo collapsed at least two verdicts, including the only one that
   compared correctly.
3. **Pick a disposition from § 2b-bis** — REFUSE or PRESERVE — by asking what refusing costs the
   player. If PRESERVE, use the shared bag; do not write your own.
4. **Decide what happens on `unreadable`, separately.** ⚠️ The disposition above answers `too-new`
   only, and `unreadable` is the verdict that actually caused #778 — a build reads its defaults out
   of a damaged file and writes them back over the authored content. Answer two questions: **what
   does the damaged file still IDENTIFY** (a GUID, a key, an id that other content references — pull
   it out textually before you replace anything, and refuse to guess if it is itself ambiguous), and
   **is the content recoverable from anywhere else?** If it is not authored — regenerable from a
   source asset or a server — replacing it is fine. If it is authored, move it aside first: the
   `.meta.json` sidecar quarantines to `<file>.corrupt`. Following steps 1-3 and 6 alone will pass a
   green gate and reproduce #778 exactly.
5. Stamp on write from the constant (`preservedVersion` if PRESERVE); never echo the stored value.
6. Pick a refusal channel that fits your caller, and **add a row to §3** including its disposition.
7. Add a test that seeds a `too-new` document and asserts the bytes are unchanged after the refusal
   (REFUSE) or that its fields and version SURVIVE a write (PRESERVE) — not merely that the call
   failed. A cache-only or return-value assertion passes without the fix.

Related: [player-prefs.md](./player-prefs.md) · [ota-updates.md](./ota-updates.md) ·
[ota-subgame-modules.md](./ota-subgame-modules.md) · [editor.md](./editor.md) ·
[scene-loading.md](./scene-loading.md)
