/** The prefab format WRITE gate (#1468 D4) — refuse to overwrite a `.prefab.json` written by a
 *  build newer than this one.
 *
 *  ## The reversal this implements, stated as one
 *
 *  `docs/format-versioning.md` listed Prefab as *"⚠️ raises only — nothing branches; a writer-only
 *  stamp, **confirmed, not a gate to be invented** (#365)"*. That was a deliberate decision, made
 *  after a review found a prefab version gate asserted as fact in four places when none existed.
 *  **It is now reversed by owner ruling**, because #1468 puts a minted node identity in the prefab
 *  document: an older build that re-serializes such a file drops the ids it does not know about,
 *  keeps the file's guid, and leaves every instance pointing at a document whose identity was
 *  silently erased.
 *
 *  ⚠️ **The LOADING path still does not inspect the version, and that is the ruling, not a gap**
 *  (owner, 2026-09-23: *"B is my choice"*). A build meeting a newer prefab **opens it normally** and
 *  refuses only the SAVE that would strip it. That is `docs/format-versioning.md` § 1's rule —
 *  *"read defaults, carry on, and leave the bytes alone"* — which prefabs are the last document to
 *  get. So comments elsewhere saying nothing on the load path reads this constant remain TRUE.
 *
 *  ## Why the comparison is one-directional, and why `!==` would be catastrophic
 *
 *  **Prefabs have no migration ladder.** Measured 2026-09-23: the committed corpus is 102 prefabs at
 *  `version: 2` and 3 at `version: 3`, against a constant that has only gone UP since (re-measured
 *  at the 4 → 5 bump; the corpus figures still hold) — **not one authored prefab is at the
 *  current version**, and they all load correctly. A gate spelled "refuse anything that is not
 *  current", which is how the SCENE gate reads, would refuse all 105 on the first save. So: refuse
 *  **strictly newer**, accept everything older, forever.
 *
 *  ## Why this is server-side and not in the editor
 *
 *  A census of every path a `.prefab.json` can reach disk (#1468 Phase 2A) found **17 writers**.
 *  Four go through `writePrefabFile`; four more bypass it but still use the client write wrapper;
 *  **five are server-side with no client call at all** — the asset scanner's GUID heal, which fires
 *  from the file watcher with no route, `/api/prefab-member-paths`, which rewrites prefabs the
 *  caller never named, `/api/scene-mutate`, `duplicateAssetFile`, `/api/import-file` — and four are
 *  Node migration scripts. A guard in `writePrefabFile` would have covered 4 of 17 while looking
 *  finished, which is this repo's own `family/one-entry-point` defect.
 *
 *  The client wrapper is not the answer either: `jsonFileBody`/`writeAssetFile` are PUBLIC
 *  (`editor/index.ts`) so a game's own panel can write through them, and
 *  `clientJsonWriteSeam.test.ts` does not scan `games/**`.
 *
 *  ## Where it is wired, and — just as deliberately — where it is NOT
 *
 *  ⚠️ **The hazard is not "a write", it is a write that REBUILDS the document from a typed model.**
 *  `assetJsonBytes` is a plain `JSON.stringify(doc, null, 2)`, so any writer that does
 *  `JSON.parse` → change one field → write back is **lossless**: every field it has never heard of
 *  survives untouched. Gating those would refuse harmless work and teach people to route around
 *  the gate, which is how a guard stops being believed.
 *
 *  | writer | rebuilds? | gated |
 *  |---|---|---|
 *  | `serializePrefab` (from the live ECS world) | **yes** | ✅ via `/api/write-file` |
 *  | `mergeRiggedPrefab` (a 5-field object literal) | **yes** | ✅ via `/api/write-file` |
 *  | `applyToPrefabSelective` (round-trip, but re-stamps `version`) | no, downgrades the stamp | ✅ via `/api/write-file` |
 *  | `writeAssetGuid` (parse → set `id` → write) | no — lossless | ✅ precautionary, see below |
 *  | `planMemberPathRepair` (parse → remap tokens → write) | no — lossless | ❌ deliberate |
 *  | `duplicateAssetFile` (parse → set `id` → write, to a NEW path) | no — lossless | ❌ deliberate |
 *
 *  **`writeAssetGuid` is gated even though it loses nothing today**, because the sidecar refusal
 *  immediately below it in the same function does the same thing for the same reason, and because
 *  "lossless" is a property of the fields that exist now rather than a guarantee. It fires from the
 *  file WATCHER, so it is also the one write that happens with nobody looking. Stated as
 *  precautionary rather than dressed up as closing a demonstrated loss.
 *
 *  **`planMemberPathRepair` and `duplicateAssetFile` are deliberately NOT gated.** Both are
 *  lossless, and refusing them would break work that is legitimate on a too-new document: you could
 *  not duplicate the file, and a repair of every OTHER prefab would be blocked by one newer one it
 *  merely mentions. ⚠️ **Revisit `planMemberPathRepair` if a future format changes member
 *  ADDRESSING** (Phase 2B does exactly that) — rewriting tokens under the old grammar is a real
 *  hazard, it is simply not the hazard D4 is about, and it needs its own decision rather than being
 *  folded in here.
 *
 *  ## What it refuses, and what it deliberately does NOT
 *
 *  **`too-new` only.** An `unparsable` or `not-an-object` document is damaged data, not a format
 *  refusal, and its disposition is different — refusing to overwrite a corrupt prefab would make it
 *  unfixable from the editor, with no quarantine path like `.meta.json` has
 *  (`quarantineCorruptSidecar`). Collapsing the two verdicts together is the #778 defect, and
 *  `meta-sidecar.ts`'s `assertSidecarWritable` says so in as many words.
 *
 *  ⚠️ **One exception, borrowed from that same precedent: a numerically-NEWER non-integer version.**
 *  `classifyFormatVersion` calls `"version": 5.5` `unreadable`/`non-numeric-version`, so the rule
 *  above would wave it through and overwrite a file that is plainly from the future. `rawPrefabVersion`
 *  exists only for that case, exactly as `rawSidecarVersion` does.
 */

import fs from 'node:fs';
import { PREFAB_FORMAT_VERSION } from '../packages/modoki/src/runtime/core/version';
import { classifyJsonFormatVersion } from '../packages/modoki/src/runtime/core/formatVersion';

/** Is this a prefab document, by path? The gate is keyed on the suffix because `/api/write-file` is
 *  byte-opaque by design and has no other way to know what it is writing. */
export function isPrefabPath(p: string): boolean {
  return p.endsWith('.prefab.json');
}

/** The `version` value as it literally sits on disk, unclassified — used ONLY to keep a
 *  numerically-newer NON-INTEGER version refusing (see the docblock). */
function rawPrefabVersion(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>).version;
  } catch {
    return undefined;
  }
}

export interface PrefabWriteRefusal {
  /** The version the document on disk carries. */
  stored: number;
  /** This build's constant. */
  current: number;
  /** Ready to log or return in a 409 body. */
  message: string;
}

/** `null` when `absPath` may be overwritten — including when it does not exist, is unreadable, or
 *  is not a prefab at all. A refusal otherwise.
 *
 *  ⚠️ **Synchronous on purpose.** `/api/write-file` carries an `ifMatch` precondition whose rule is
 *  that nothing may `await` between the check and the write; an async read here would reopen that
 *  race for every conditional write, not just prefab ones. */
export function classifyPrefabWrite(absPath: string): PrefabWriteRefusal | null {
  if (!isPrefabPath(absPath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null; // absent (or unreadable at the fs level) — a first write, which is correct
  }
  const verdict = classifyJsonFormatVersion(text, PREFAB_FORMAT_VERSION);
  const stored = verdict.kind === 'too-new'
    ? verdict.version
    : (() => {
      // The non-integer-but-newer case the classifier reports as `unreadable`.
      const raw = rawPrefabVersion(text);
      return typeof raw === 'number' && Number.isFinite(raw) && raw > PREFAB_FORMAT_VERSION ? raw : null;
    })();
  if (stored === null) return null;
  return {
    stored,
    current: PREFAB_FORMAT_VERSION,
    message: `${absPath} was written by a newer build (prefab format ${stored}; this build writes ${PREFAB_FORMAT_VERSION}). `
      + 'Refusing to overwrite it — saving would silently drop the fields this build does not know about. Update your build.',
  };
}
