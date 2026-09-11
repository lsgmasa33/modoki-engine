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
still caught a real defect in the second one (#763). **Both copies are gone as of #813** — the game
now calls the shared helpers, so the ordering invariant lives in one place rather than in four
comments in one game.

**Import them from the narrow subpath, `@modoki/engine/runtime/core/formatVersion`, not from the
`@modoki/engine/runtime` barrel** (#813). `formatVersion.ts` has no imports of its own, so the narrow
entry costs nothing to load; the barrel drags the whole runtime graph in, which matters because the
modules that need these helpers are exactly the pure format modules a game keeps loadable without a
world, a renderer or a storage backend. Measured on wordweave's `store`+`save` suites: 1.64s before
the de-dup, **9.07s** via the barrel, **1.67s** via the subpath.

⚠️ **Swap the BAG and nothing else — do not also transfer the version rule.** The two documents in a
game are rarely symmetric: wordweave's purchases doc has no version-GATED field, its progress doc
does (`activeGuid` is kept only when the stored version is readable). #763's close-out caught
`readProgress` copying `readPurchases`'s `v = max(stored, current)`, which disarmed the version floor
for the one field the floor protects. `preservedVersion`'s own banner carries the same warning.

⚠️ **Keep the reader's conditional SPREAD when you swap.** `collectUnknownFields` returns `undefined`
rather than `{}` so the key can be omitted entirely; `unknownFields: collectUnknownFields(…)` instead
*sets* the key to `undefined`, which `Object.keys` and a structural compare can see. This is easy to
get wrong and easy to believe you have tested: `expect(doc.unknownFields).toBeUndefined()` passes
either way, and a serializer built on `mergeUnknownFields` normalises the difference away, so #813's
mutation check found the whole 76-test suite green under exactly that mistake. Assert
`'unknownFields' in doc === false` on the READER's own result — `games/wordweave/tests/save.test.ts`
and `store.test.ts` carry the pattern.

⚠️ **A PRESERVE writer that ALSO syncs to the cloud must carry the bag on the WIRE too, IN PLACE —
never as a side-car field** (#760 phase G; Court's `saveSync.ts`/`systems.ts` is the worked example).
The disc write alone is not enough for a signed-in player: a build that only preserves locally still
loses an unrecognised field the moment it rolls back AND syncs, because the sync layer's own document
shape is typically a second, narrower named-field projection of the same data (Court's `CourtSave`)
that never carried the bag through. The fix is the SAME shape twice — hoist the bag out of every
sub-document as one field for the whole in-memory journey (never smeared across the pieces it came
from, or every comparison downstream has to know to look in several places), and re-nest it back onto
the DISC/WIRE position it came from at every write, never at a new top-level key. A side-car would
sit at the WRONG position for a build that later adds a REAL field of that name, and would never stop
being carried forward as a shadow copy once one did.

⚠️ **Exception: a group whose WIRE format is FLATTER than its disc shape cannot round-trip every
level, and that is not a bug in the rule above — it is a limit the rule must state rather than
promise past.** A wire key this build does not recognise always lands back in the single deepest
bucket the flatter wire shape can represent, because that is the only place left for it once the
nesting the disc side carries has been collapsed away for the wire. Such a group carries only the
bucket the wire can express, and its own documentation must say which level stays LOCAL-only and
does not survive a round trip through the wire. Court's `court.settings` is the worked example —
`nestSettingsSave` writes the flat wire shape, `collectSettingsWirePreserved` is the bag collector
on that shallower side — and its own accounts doc names the local-only level explicitly rather than
leaving a reader to assume the general rule above covers it whole.

**The obligation this places on every future build:** a field a synced PRESERVE document adds must
also be added to `stableSections` (or whichever function decides that document's sync
DIRTINESS/fingerprint) **conditionally** — the `dailySpend`/login-bonus idiom in Court's
`stableSections` (`saveSync.ts`), added via `...(x.length ? [x] : [])` rather than unconditionally, so
a save that has never touched the new field fingerprints BYTE-IDENTICALLY to one from before the
field existed. Skipping this is not silently safe in the other direction either: a field that never
joins `stableSections` will not upload from a rolled-back build EITHER, exactly the gap this phase
closes for everything that predates it — the bag preserves it locally and across an ordinary sync,
but a device that never independently dirties for a REASON having nothing to do with the new field
may sit on it without ever being asked to upload.

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

⚠️ **The same refusal shape is reached from a second direction, and it is worth knowing they meet.**
An asset editor must also refuse a document it could not READ AT ALL — a corrupt, truncated or
conflict-markered file, or a failed fetch — for the identical reason a too-new one is refused here:
these panels write with `replace: true`, so opening on a substituted document and editing one field
replaces the file wholesale. That half is `editor/panels/assetDocLoad.ts` and is documented in
[editor.md](editor.md) § "A failed read yields NO document"; a document with no format constant
(`.anim.json`, `.spriteanim.json`, `.timeline.json`, `.rig2d.json` — § 3) gets only that half, since
there is no version to classify. ⚠️ A genuinely MISSING file is neither: defaults are correct there,
and refusing would make a brand-new asset unauthorable.

## 3. The decision table — every ENGINE-owned versioned document

The corpus of documents the engine itself defines and reads/writes. A new versioned document owned
by the engine adds a row here in the same change that introduces it.

⚠️ **A game can own versioned documents of its own, and this table does not enumerate them** — Court's
`SESSION_SCHEMA_VERSION` (`games/court/runtime/session.ts`) and wordweave's `SAVE_SCHEMA_VERSION`/
`PURCHASES_SCHEMA_VERSION` (`games/wordweave/runtime/save.ts`, `store.ts`) are all real, live
constants and none of them is a row below. A game records its own documents' disposition in its own
feature doc — Court's is `games/court/accounts.md` § "PRESERVE at the write — surviving a build
rollback (#760)", covering `court.purchases`/`court.progress`/`court.settings`/
`court.analytics.install`/`court.account`/the wipe-pending marker/**`court.session.<levelId>`**.
**`court.session.<levelId>`'s disposition is now decided (#760 phase F, corrected by review fix #1):
PRESERVE an unknown top-level field, but always stamp `v` to the CURRENT build's own version, never
a loaded document's** — see `serializeSession`'s own banner in `session.ts` for the full reasoning.
The reason it is NOT simply "PRESERVE, like the rest of the table": `log` is version-GATED (exactly
the case § 2b-bis's `preservedVersion` helper is the wrong tool for), and this build always rewrites
that field wholesale rather than merely re-serializing an untranslated one, so `v` must describe what
THIS build wrote, not what an unreadable newer document claimed.

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
| `.atlas.json` | `ATLAS_FORMAT_VERSION` (`runtime/loaders/spriteAtlas.ts`) | REFUSE | ✅ | the panel's existing `loadState` gate, as a **distinct `'refused'` state** — same disabled editing as a load failure, different banner, because "Could not load — Retry" is a wrong diagnosis for a right symptom. `reimport-atlas.ts` throws a named verdict into the three contexts that already handle a throw (build fails red, dev repack collects a per-asset error, `modoki_import_file` returns 422). The `version: 1` that the atlas panel's own unknown-key preservation was clobbering is gone (phase C2a) |
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
`SceneManager.collectSceneResourceRefs` ended with `sceneData.version = Math.max(sceneData.version ??
6, 6)` and ran *earlier*, on the same object. (Past tense throughout this paragraph: that line was
**deleted in #807** — see the ⚠️ note below. It is quoted here because the trap is what matters, and
a reader grepping the repo for it will not find it in any source file.) `Math.max` numerically
coerces, so `"5"`, `"13"`,
`2.5` and `null` all reached the guard as a clean `ok`: the entire `unreadable` half of the
disposition was dead in production, while a unit test calling `loadSceneFile` directly proved it
worked. **Ask what mutates the document between the bytes and your verdict** — and prefer to
classify where the bytes are first parsed, not where they are first used. The test that would have
caught it is the one driven through the real caller; the one that did not is the one that called
the classified function directly.

⚠️ Related, now fixed (#807): that same `Math.max` also RAISED an older numeric version to 6, so a
genuine v3 scene got stamped 6 and skipped the v3→v6 rungs entirely — latent only because the
committed corpus bottoms out at v9. The fix deletes the raise outright rather than adjusting it:
`sceneData.resources = allRefs` (the line just above it) already records the real fact — "this
scene now has a resources manifest" — in the correct field, and the version raise was a second,
wrong way of saying it: a manifest-collected fact written into the FORMAT-version field (§ 0's three
kinds of version are not interchangeable). Nothing downstream needed it: `migrateV5toV6` only synthesizes `resources` when it's
absent, and `collectSceneResourceRefs` had already set it; the numeric-coercion half is handled
upstream by `SceneManager`'s own `classifyFormatVersion` call, which refuses `too-new`/`unreadable`
before `collectSceneResourceRefs` ever runs. The lesson above still stands and is the reason this
was catchable at all: the regression test lives in `SceneManager.test.ts`, driven through the real
`SceneManager.loadScene` entry point (seeding a v3 fixture and asserting the v3→v4→v5 UI-trait
reshaping actually happened), not in `loadSceneFile.test.ts` — that file's existing v3→v4/v4→v5/v5→v6
coverage calls `loadSceneFile` directly and passed with the bug fully in place, exactly as § 4's
fifth trap predicts.

⚠️ **And a non-trap, recorded because it was written down as fact first.** That fix also claimed
the quarantine file would be scanned as an asset unless its suffix was explicitly skipped, reasoning
from `.meta.local.json`, which genuinely needed that. It is false: `.meta.local.json`'s extension is
`.json` and hits the JSON branch, whereas `.corrupt` falls through `EXT_TYPE[ext] || null` and
classifies as a non-asset with or without the clause. Measured by passing a bare `.corrupt` path the
clause does not match and getting `null` anyway. The clause stays as belt-and-braces; the claim that
it is load-bearing does not.

## 4b. A document-supplied KEY is not a safe object key — normalize at the boundary (#912)

Everything above is about a document's FIELDS. This section is about its **keys** — a product id, a
transaction id, a date string — and it is a different failure, with a different fix.

**A key read out of a document can collide with `Object.prototype`.** `JSON.parse` makes `__proto__`
an ordinary own enumerable key, so a stored or synced document really can carry one, and the other
seven member names (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`,
`propertyIsEnumerable`, `toLocaleString`) become ordinary own keys the moment they are assigned.
Two silent shapes follow:

| shape | what happens |
|---|---|
| `bag[k] = v` | for `k === '__proto__'` this hits `Object.prototype`'s SETTER: no own key is created, the value is lost, and the prototype is replaced by document data |
| `k in bag` | true for **all 8** names even when the key is absent, so the test takes the wrong arm — and where that arm indexes the other operand, it throws |

### ⚠️ The lesson is about the FIX SHAPE, not the bug

#813 fixed this the obvious way: a `putOwn()` helper (`Object.defineProperty`) called at each copy
site. **It took four review rounds, each found more sites, and round four found that the sweep had
fixed producers while leaving consumers on the same defect** — including a `putOwn` that was inert
because the next hop still dropped the key. Fourteen sites later, ~14 were still live.

**N sites failing one way is a missing abstraction, not a longer to-do list.** The fix that ended it
was one line at the READ BOUNDARY: `emptyDocMap()` (`games/court/runtime/saveSync.ts`) starts every
document-keyed bag with a **null prototype**, which fixes both shapes at once — an assignment creates
a real own key, and `in` answers about the bag. Most remaining plain-assignment sites then needed no
edit at all, because they became correct where they stood.

⚠️ **"Needed no edit" is true only where the ACCUMULATOR is a doc map, and the close-out review found
two sites where it is not.** `mergeDailyProgress` and `mergeDailyPurchased` build their accumulator
with a **spread** (`{ ...A.purchased }`), which is key-safe but yields an ORDINARY prototype whatever
the source was — so converting the readers did not reach them. Worse, converting the readers made
their loss **newly reachable**: before, a prototype-named receipt was dropped at the read boundary and
could never leave the device; after, it survives, uploads, and can arrive on the server side of a
conflict merge, where these two dropped it and the `merge:false` push destroyed the server copy too.
⚠️ **How much is lost depends on the VALUE, and the first write-up of this got it wrong** — it said
"all 8 names" from a test that used a made-up receipt value. `__proto__` is always lost. The other
seven reach a `mine < id` compare against an inherited function that stringifies to
`"function toString() { [native code] }"`, so they survive whenever the value sorts before that —
which every lowercase-hex GUID level id does. In normal play the loss is `__proto__` alone; an empty
levelId (producible, and stored as `''`) loses all 8. **A measurement taken with an invented value is
a measurement of the invention** — this is the second unmeasured claim this section has had to
correct, after #813's.

**The lesson generalises: a boundary fix converts the places data ENTERS, and a spread-built
accumulator downstream is a second entry point.** Sweep for `{ ...x }` accumulators over
document-supplied keys as well as for `{}` ones.

### ⚠️ Two things that must stay true for that to be safe, and both were MEASURED

**Neither was taken on trust — #813 rejected the null-prototype shape on an argument nobody had
tested, and that inherited rejection is what kept the class alive for four rounds.**

1. **Nothing null-prototyped reaches storage.** `JSON.parse(JSON.stringify(x))` and
   `structuredClone(x)` both keep `__proto__`/`constructor` as own keys AND return an ordinary
   prototype — so the PlayerPrefs leg and the Capacitor-bridge leg to
   `FirebaseFirestore.setDocument` are both clean. `{ ...bag }` converts explicitly if a boundary
   ever needs it.
2. **Nothing calls a method ON a bag.** A null prototype genuinely breaks `bag.hasOwnProperty(...)`.
   Court makes **zero** such calls — every site already uses `Object.prototype.hasOwnProperty.call`.
   ⚠️ **That convention is the load-bearing part: a new direct method call on a bag is what would
   break this**, and it will fail loudly rather than silently, which is the right way round.

### Three sites still needed a hand fix, and the reason generalises

A null prototype on OUR bag cannot help when the object arrives **from a caller**. Court's two
`k in next.entitlements/passes` tests and `reconcileDailySpend`'s `key in known` all read a
caller-supplied object, so they use `Object.prototype.hasOwnProperty.call(...)`, which is correct for
either prototype. **Ask where the object came from before deciding which of the two fixes applies.**

⚠️ **An empty early-return is a bag too.** All four of Court's normalizers returned a plain `{}` for
a missing document; a caller doing `k in normalizeX(undefined)` inherits the same 8 names off it.

### Realistic exposure, so nobody over-invests

A real key named `__proto__` means a hostile or corrupted document, not ordinary play. It is worth
the ticket because `games/court/tests/cloudFormatPreservation.test.ts`'s **T5 states an explicit
guarantee** that an unreadable entry survives both sync legs, and these were the key shapes for
which it did not hold — plus the `k in` shape was a live **crash** in shipped Court for every
`Object.prototype` name until #813.

Covered by `games/court/tests/docMapBoundary.test.ts` (the boundary, all 8 names) and T5d in
`cloudFormatPreservation.test.ts` (the upload leg). ⚠️ **The two are not interchangeable, and a
mutation check is what established that:** `nestEntryMap` runs only on the sync path, so a local
read/write case asserting on it stays green with the mechanism deleted. That trap is the reason T5d
lives beside the guarantee rather than with the rest of the boundary cases.

### 4b-bis. The ENGINE instance, and its two primitives (#986)

§ 4b above is Court's telling of this. The engine had **~18** of the same sites, and #986 fixed 15 of
them behind two exported primitives — so a game no longer has to hand-roll a third vocabulary:

```ts
import { emptyDocMap, hasDocKey, putOwn } from '@modoki/engine/runtime'
```

| primitive | when | why |
|---|---|---|
| `emptyDocMap<T>()` | the bag is **ours** to build | `Object.create(null)`, so every downstream `bag[k]` / `k in bag` becomes correct **where it stands**, with no edit |
| `hasDocKey(bag, k)` | the bag **arrives** — a caller's argument, a code-declared table, an `Object.fromEntries` result | a null prototype cannot help there; this is the `hasOwnProperty.call` form |
| `putOwn(bag, k, v)` | the bag must stay **ordinary** but takes a document key | `defineProperty` DEFINES rather than sets, so `__proto__` round-trips *without* replacing the prototype |

`emptyDocMap` takes Court's name deliberately (§ 4b). A game imports neither the engine's internals
nor another game, so the two cannot literally share code — but one vocabulary across the repo beats
two accurate-but-different names.

**`putOwn` is the primitive § 4b did not need and the engine did.** Several engine bags cross into a
**third-party library** — koota's `entity.set`, a TSL shader function, PixiJS's `Shader`
constructor — where a null prototype is untested risk for no gain. `putOwn` fixes the write while
leaving the object ordinary. Node-side callers import the granular
`@modoki/engine/runtime/core/docKeys` subpath, never the barrel, which drags the browser runtime
into a Node tsconfig.

⚠️ **Three of the 18 are NOT this mechanism and were split out as #993** — vocab-table lookups
(`WRAP[s.wrapS]`, `SHAPE[...]`, `COLLIDER[...]`) where the table is a code literal, fixing the guard
alone still lets the prototype value flow, and one has no guard at all so "fixing" it means choosing
a fallback. Bending them to fit would have been a forced family. That split turned out to be the
larger half — **§ 4b-ter**, below.

⚠️ **One #986 guard is deliberately UNTESTED, and the mutation check is why.** `mergeParamDefaults`'
read guard changes no output: `coerceParamValue` type-checks every branch and falls back to the
schema default, so a prototype-read function is sanitised to exactly what a correct read produces.
Two tests were written for it and **both stayed green with the fix reverted**; they were deleted
rather than banked, and the call site says so. Keeping a passing assertion over an unreachable
mechanism is the shape [docs/falsifiable-tests.md](falsifiable-tests.md) exists to stop.

**What makes the engine conversion safe is checkable, not assumed:** a direct `bag.hasOwnProperty(k)`
is the one thing a null prototype breaks, and a sweep of `engine/packages/modoki/src`, `engine/app`
and `engine/plugins` finds **zero** — the same `.call`-form convention that made § 4b safe in Court.
⚠️ **A new direct method call on a doc map is what would break this.**

Covered by `engine/packages/modoki/tests/runtime/docKeys.test.ts` (34 cases). ⚠️ **Almost every case
uses one of the OTHER SEVEN names, not `__proto__`** — only `__proto__` goes through a setter, so a
`__proto__`-only suite stays green against the entire read half, which is most of these sites.

### 4b-ter. The READ side — a code-declared VOCABULARY TABLE indexed by a document string (#993)

§ 4b-bis is about bags **we build**. This is the other half, and it is bigger: **22 sites** where a
*code-declared literal object* is used as a vocabulary table and indexed with a string that came from
outside the code. The table was never a bag anybody thought of as document data — it is a `const` a
few lines up — which is exactly why the reads went unguarded.

⚠️ **Every count in this section is stamped as of #993's close-out, not derived** — it went 16 → 20 →
22 in one day as review found members, and a stale copy survived each bump. It cannot be derived:
the fixed sites share no single greppable spelling (`loaders/primitives.ts` was fixed by asking
`isPrimitive`, not with `hasDocKey`). If you find a member, update the count here in the same change.

> **The mechanism, in one sentence:** a code-declared literal inherits `Object.prototype`, so a key
> like `constructor`, `toString` or `valueOf` returns an inherited **FUNCTION**, and the value flows
> on because the guard beside the read cannot see it.

⚠️ **All four of the guard shapes people reach for fail, and this is the part worth memorising:**

| written as | why it does not hold |
|---|---|
| `if (!(key in TABLE)) warn(…)` | `'toString' in TABLE` is **true** — the warning never fires |
| `TABLE[key] ?? fallback` | a function is **not nullish** — `??` never fires |
| `TABLE[key] \|\| fallback` | a function is **truthy** — `\|\|` never fires |
| `const v = TABLE[key]; if (!v) return` | same: truthy, so the early return is skipped |

⚠️ **`??` fails one step earlier too, on the EMPTY STRING** (#1074). `params?.bus ?? 'master'` keeps
`''`, because `''` is not nullish either, so the fallback never runs and the empty string reaches
whatever comes next. In `audio.setBusVolume` that was a key builder, `''[0].toUpperCase()`, which
threw out of `dispatchUIAction`. When `''` means "unset", say so at the read
(`raw == null || raw === '' ? undefined : raw`). When it doesn't, it is just another unknown key
and the refusal handles it.

**The fix is `hasDocKey` at the read**, never a fourth spelling:

```ts
const wrap = hasDocKey(WRAP, s.wrapS) ? WRAP[s.wrapS] : undefined
```

Why not a `Map`: `Object.hasOwn` is already a *second* spelling in the tree
(`loaders/primitives.ts`, `haptics/patterns.ts`, Court's `saveSync.ts`), a `Map` would be a **third**,
and it would change every declaration site — plus its iteration and spread behaviour — to repair
a defect that lives entirely on the read.

**Severity is decided by where the KEY comes from, not by what the table holds.** Ranked, as they were
found:

| key provenance | example site | what it cost |
|---|---|---|
| a **URL query param** | `games/scroll-demo/runtime/config.ts` | `?scene=constructor` sets `scenePath` to a function |
| a **debug/HMR protocol payload**, and the value is **invoked** | `app/debug/agentBridge.ts` | `kind:"constructor"` calls `Object(path)` |
| an **agent tool payload** | `runtime/core/journal.ts` | every `>=` is false → the journal returns **zero events**, which the agent reads as "nothing happened" |
| **scene/prefab JSON**, a trait NAME | `loaders/sceneValidation.ts` (validation, every scene), `loaders/loadSceneFile.ts` (the v5→v6 migration) | `.includes` / `for…of` on a function → **TypeError** |
| **scene JSON**, a trait FIELD | `audio/audioService.ts` (`AudioSource.bus`) | `tail.connect(Object)` → **TypeError**, that entity's audio dies |
| an asset `.meta.json` / `.particle.json` / `.shader.json` | `textureResolver`, `gpuComputeBackend`, `shaderSchema` | a function assigned into a three.js enum or a GPU uniform |
| a **GLB node name** | `games/3d-test/runtime/config.ts` | a stringified function as the editor's display name |
| a **font filename** segment | `loaders/fontNaming.ts` | `match.weight` is `undefined`, so the face ships with no weight |
| a **GLB attribute semantic**, at BUILD time | `plugins/model-convert/threeAdapter.ts` | ⚠️ **nothing, today — unreachable** (measured, #1069): gltf-transform's reader throws `prevRef.dispose is not a function` on a prototype-named semantic before the adapter runs. The guard is kept for the day that changes; `threeAdapter.test.ts` pins the premise |
| a **scene-JSON trait name**, at BUILD time | `plugins/detect-modules.ts` | a garbage module flag in the bag handed to the build's `define`s |
| **scene JSON**, a game config field typed `'x' as string` (#1061) | Court's `systems.ts` — `COIN_SETS[cfg.coinSet]`, `UNIT_PX[widthUnit]` | the inherited `valueOf` is **invoked** → TypeError on every piece drawn; a panel half-width of NaN |

⚠️ **`'metal' as string` reads like a union at the call site, and is not one** (#1061). #993's triage
ejected Court's tables as "keyed by TS unions the code produced" — right for `haptics.ts`,
`accountUi.ts` and `debugTab.tsx`, wrong for `COIN_SETS`, whose key is a trait field declared
`coinSet: 'metal' as string`. An Inspector `enum` over the same field does not narrow it either: the
dropdown constrains ONE authoring surface, while the scene file and `modoki_mutate_scene` write any
string. **Classify a key by its DECLARATION and every route that writes it, never by how it is used.**

Three findings that generalise beyond this family:

- ⚠️ **Two functions over one table, disagreeing.** `loaders/primitives.ts` had `isPrimitive` using
  `Object.hasOwn` **three lines above** `createPrimitiveMesh` indexing the same table raw. A correct
  guard existing nearby is not protection; it is camouflage. The fix was to make the second function
  ask the first, not to add a third check.
- ⚠️ **A sibling read in the same function can be the proof.** `gpuComputeBackend` had two vocab
  fields one screen apart where an identical typo **warned and fell back** in one and was **silently
  `undefined`** in the other. Two fields disagreeing about one class of typo is a design question,
  not a lint fix — it went to the owner, who chose warn + fall back at runtime **and** a picker at the
  authoring surface.
- ⚠️ **A picker whose options are hand-listed is a second copy of the table.** The Inspector's
  collider-shape picker already existed — with its four options typed out beside a separate four-entry
  `COLLIDER` table, so the first shape anybody added would have appeared in one and not the other.
  `COLLIDER_SHAPES` is now the one list, the picker spreads it, and the GPU table is typed
  `Record<ColliderShape, number>` so a new member fails to compile until it has a shader code. This is
  root `CLAUDE.md` § "Author values in the SCENE and the PREFAB" in its read-the-field form.

⚠️ **Not every site is reachable by every name, and that decides which case is the test.**
`fontNaming` is the worked example: `.toLowerCase()` kills six of the eight, the `split(/[-_]/)`
kills `__proto__`, and **`constructor` alone survives both** — so seven of its eight cases pass with
or without the fix and only one of them is evidence. Work out which names actually reach the read
before writing the assertions, or the suite looks eight times stronger than it is.

⚠️ **The reachable half is the OTHER SEVEN names, not `__proto__`.** These are all *reads*, and
`__proto__` is the only one that goes through a setter — so a `__proto__`-only test suite stays green
against every site in this family. `docKeys.test.ts` enumerates all eight for that reason; copy it.

⚠️ **And test the ACCEPT side of every one.** A table that answers `undefined` for everything passes
every reject case while breaking all texture wrapping and every particle emitter. The coverage
baseline when #993 was first written up — **sixteen** sites at the time, before review found the
other six — was that **zero of those sixteen had a test that failed**, and
`games/3d-test/tests/tropicalIslandConfig.test.ts` asserted the right thing in a way that passed
before *and* after the fix — [docs/falsifiable-tests.md](falsifiable-tests.md)'s shape, already in the
tree.

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
   ⚠️ **`preservedVersion` is the wrong tool the moment your document has a version-GATED field that
   this build REWRITES**, and its own docblock says so — *"check that every field you are about to
   write is one this build actually implements at the version being claimed."* Court's session
   document is the worked example, and it was got wrong first (#760 phase F, caught in review):
   `deserializeSession` DROPS the undo log on a version mismatch, so the log written back is this
   build's own — and preserving the stored higher version made a future build see its own number,
   trust the document, and replay a log written under semantics it does not share. The rule that
   falls out: **the version must describe the content you actually wrote.** Preserving a higher
   version is right when you carried everything through unread; stamping your own is right when you
   rewrote the field the version gates. Nothing is lost by stamping down in that case, because the
   unknown fields are preserved either way — the two halves are independent.
6. Pick a refusal channel that fits your caller, and **add a row to §3** including its disposition.
7. Add a test that seeds a `too-new` document and asserts the bytes are unchanged after the refusal
   (REFUSE) or that its fields SURVIVE a write (PRESERVE) — not merely that the call failed. A
   cache-only or return-value assertion passes without the fix. **The version half of that
   assertion is conditional on step 5's caveat**: assert the version survives too ONLY when the
   document has no version-gated field this build rewrites; when it does, the version being
   asserted is THIS build's own stamped-down value, not the loaded one, and a test asserting
   "survives" would be pinning the exact regression step 5 describes (Court's session document,
   #760 phase F/review fix #1, is the worked example both ways — `session.test.ts`'s "must stamp
   THIS build's own version, not preserve the newer one").

## 6. The `family/persisted-schema` label — a summary, not the boundary

The tracker groups this work under `family/persisted-schema`. Two things about that label have
already caused a wrong call each, so they are recorded here rather than in the label text, which has
a hard 100-character cap and can only ever be a summary.

**Membership is about the MECHANISM a design must address, not a patch the members share.** The
members' fixes genuinely differ — #760 carries unknown fields through a write; #807 stops stamping a
version it did not earn; #767 reads a `too-new` document instead of discarding it. They are one
family because **one design has to answer all of them**, which is the whole reason the owner ruled
(2026-09-06) that a family is designed across rather than fixed member by member. Reading the label
as "these share a patch" is what makes a member look like it belongs somewhere else.

**Measure a candidate against the membership, not against the label's wording.** #807 was excluded
from this family on the strength of the description alone — and the description at the time
(*"old build reading a NEWER doc drops what it doesn't know"*) matched only three of the nine
members. It was describing one member's symptom. The corrected description covers two mechanisms
deliberately: *loses* (unknown fields destroyed — #760, #767, #778, #821) and *misstates* (a version
written that the content does not satisfy, in either direction — #734 lowering, #807 raising).

⚠️ **Two members fit "misstates" only loosely, and knowing which ones is the point.** #730 and #629
are neither: nothing is lost and nothing is stated wrongly. Their defect is a version that guards
**nothing** — written on every publish and read by no branch; two constants that never meet. Call it
**"written but unbranched"** if it needs a name. It is arguably a third mechanism in this family, and
a reader measuring a new issue against the two-word description will not find it there.

Related: [player-prefs.md](./player-prefs.md) · [ota-updates.md](./ota-updates.md) ·
[ota-subgame-modules.md](./ota-subgame-modules.md) · [editor.md](./editor.md) ·
[scene-loading.md](./scene-loading.md)
