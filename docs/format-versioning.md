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
**Four documents remain unfixed** — `.particle.json`, `.atlas.json`, `.mesh.json`/`.mat.json` and the
profiler capture export — plus scene's disposition and prefab's recorded non-gate; they are #784, and
they are one piece of work with one design, not one ticket each.

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

⚠️ **"Warn and load anyway" is not a third disposition — it is the absence of one**, and the scene
loader currently does exactly that (`loadSceneFile.ts` logs that the file is newer than this engine
supports, then loads it and lets the ladder re-stamp an absent version). It reads a document it has
just admitted it does not understand, and then writes. Deciding scene's real disposition is part of
the remaining work in #784, not something to infer from the current behaviour.

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
| Scene | `SCENE_FORMAT_VERSION` (`runtime/core/version.ts`) | ❌ **undecided (#784)** | ⚠️ advisory only | warns, then **loads anyway**; and an ABSENT version runs the whole ladder and re-stamps |
| Prefab | `PREFAB_FORMAT_VERSION` (`editor/scene/prefab.ts`) | — | ⚠️ **raises only** | nothing branches — a writer-only stamp, confirmed, not a gate to be invented (#365) |
| IAP ledger / mock store | `LEDGER_FORMAT_VERSION` / `MOCK_STORE_FORMAT_VERSION` (`runtime/iap/`) | PRESERVE | ✅ | read + bagged; `max(stored, current)` on write-back (#767) |
| `.particle.json` | ❌ literal `1` | ❌ undecided | ❌ | **re-stamped to 1 on every load** |
| `.atlas.json` | ❌ literal `1` | ❌ undecided | ❌ | re-stamped on every patch — and its own unknown-key preservation helper clobbers it |
| `.mesh.json` / `.mat.json` | ❌ literal `1` | ❌ undecided | ❌ | loader's type does not declare the field |
| Profiler capture export | ❌ literal `1` | ❌ undecided | ❌ | one-way debug export; nothing re-ingests it |

**Not in this family, despite the name.** `Skin2DBuffer.version` is an in-memory GPU-upload dirty
counter, never serialized (see the warning below). `sync/decide.ts`'s `version` is a **data-identity**
version — a compare-and-swap revision, § 0's middle row — not a format version. Both are excluded
from the § 4 guard by name, with those reasons.

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
