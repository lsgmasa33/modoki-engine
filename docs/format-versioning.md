# Format versioning — one pattern for every versioned document

Modoki persists a lot of documents: scenes, prefabs, asset sidecars, manifests, OTA releases, player
saves. Most of them carry a `version` or `schema` number. This doc is the **single design for all of
them** — what the number means, who reads it, and what happens when a build meets a document newer
than it understands.

It exists because that question was answered **five times, four different ways**, before anyone wrote
it down. #630, #734, #730 and #629 each fixed one instance and each invented its own shape; five more
documents are still unfixed. The fix rate was never the problem — the absence of this page was.

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

## 2. The three contracts

The reason five sites produced five shapes is that only ONE of the three parts legitimately varies.

### 2a. Classification — SHARED, and identical everywhere

Given a raw parsed document and this build's constant, the verdict is one of:

| Verdict | Meaning | Because |
|---|---|---|
| `ok` | at or below this build's version | readable, possibly after a migration |
| `too-new` | strictly greater | structurally intact, semantically unknown — **protect it** |
| `absent` | no `version` field | legacy or freshly created — readable |
| `unreadable` | did not parse, not an object, non-numeric version | corrupt — safe to replace |

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

| Document | Constant | Reads it? | On `too-new` |
|---|---|---|---|
| PlayerPrefs envelope | `SCHEMA_VERSION` (`runtime/storage/playerPrefs.ts`) | ✅ | protected; `set()` warns and refuses |
| `.meta.json` sidecar | `SIDECAR_FORMAT_VERSION` (`plugins/meta-sidecar.ts`) | ✅ | throws; reimport aborts per asset |
| `subgame.json` | `SUBGAME_MANIFEST_SCHEMA_VERSION` (`runtime/core/version.ts`) | ✅ | `notEvidence` |
| `assets.manifest.json` | `ASSET_MANIFEST_VERSION` (`runtime/loaders/assetManifestVersion.ts`) | ✅ | `notEvidence`, checked **before** the merge |
| OTA `manifest.json` / `release.json` | `SCHEMA_VERSION` ×2 (`runtime/ota/otaClient.ts`, `scripts/ota/schema.mjs`) | ✅ | refused; parity test pins the two constants |
| Scene | `SCENE_FORMAT_VERSION` (`runtime/core/version.ts`) | ✅ | 9-step migration ladder |
| Prefab | `PREFAB_FORMAT_VERSION` (`editor/scene/prefab.ts`) | ⚠️ **raises only** | nothing branches (#365) |
| `.particle.json` | ❌ literal `1` | ❌ | **re-stamped to 1 on every load** |
| `.atlas.json` | ❌ literal `1` | ❌ | re-stamped on every patch |
| `.mesh.json` / `.mat.json` | ❌ literal `1` | ❌ | loader's type does not declare the field |
| Profiler capture export | ❌ literal `1` | ❌ | one-way debug export; nothing re-ingests it |
| IAP ledger / mock store | `d.v` | ⚠️ **too strictly** | whole document discarded (#767) |

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

## 5. Adding a new versioned document

1. Declare a named exported constant in the module that owns the format. Never a literal.
2. Classify on read with the §2a verdicts; keep `too-new` and `unreadable` distinct.
3. Stamp on write from the constant; never echo the stored value.
4. Pick a refusal channel that fits your caller, and **add a row to §3**.
5. Add a test that seeds a `too-new` document and asserts the bytes are unchanged after the refusal —
   not merely that the call failed. A cache-only assertion passes without the fix.

Related: [player-prefs.md](./player-prefs.md) · [ota-updates.md](./ota-updates.md) ·
[ota-subgame-modules.md](./ota-subgame-modules.md) · [editor.md](./editor.md) ·
[scene-loading.md](./scene-loading.md)
