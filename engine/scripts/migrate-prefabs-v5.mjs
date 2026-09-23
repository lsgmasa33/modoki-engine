#!/usr/bin/env node
/** Mint a `nodeGuid` on every row of every authored prefab — the prefab corpus's v2/v3/v4 → v5
 *  migration (#1468; the plan's § 4 Phase 2B "finding B").
 *
 *      node engine/scripts/migrate-prefabs-v5.mjs            # dry run — reports, writes nothing
 *      node engine/scripts/migrate-prefabs-v5.mjs --write
 *
 *  ## What v5 IS, and why that makes this the whole migration
 *
 *  Prefabs have **no migration ladder** — `runtime/core/version.ts` says so in as many words, and
 *  nothing on the loading path inspects a prefab's `version` at all. So "migrate to v5" is not a
 *  chain of transforms to replay: v5's entire content is the minted `nodeGuid` on each `entities[]`
 *  row, and the version stamp is the file becoming honest about which serializer shape it holds.
 *  Every row gets one, because `nodeGuidsFor` mints for every row with no correspondence to carry
 *  and a pre-v5 document has no correspondence at all.
 *
 *  ## ⚠️ Why this hand-rolls the transform where `migrate-legacy-scenes.mjs` refuses to
 *
 *  That script drives a RUNNING EDITOR, and its banner states the rule: *"the serializer is the
 *  only source of truth for its own output."* The rule is right and it does not reach this case,
 *  in both directions:
 *
 *   - **There is nothing to consult.** A minted guid has no correct value. Asking the serializer
 *     for one returns `crypto.randomUUID()`, which is exactly what this script writes.
 *   - **Driving the editor would be ACTIVELY WRONG.** `serializePrefab` renumbers `localId`s from
 *     BFS tree position whenever `preserveLocalIds` is absent, and only `prefabEdit` ever supplies
 *     it — so a bulk re-save would renumber the very key space every scene's
 *     `overrides`/`removed`/`moved` is written in. That is the positional fragility v5 exists to
 *     escape, arriving through the migration meant to end it.
 *
 *  ## Why the corpus has to move at all
 *
 *  A scene's member row exists only where the TEMPLATE minted a `nodeGuid`, so an instance of a
 *  pre-v5 prefab has no rows and is addressable only by `localId`. Phase 3 deletes `moved` and
 *  Phase 4 deletes the rest of that key space; until the corpus is at v5, both would leave every
 *  such instance unaddressable. Safe to run because the prefab gate refuses only a STRICTLY NEWER
 *  document (`version > PREFAB_FORMAT_VERSION`), so an older build still OPENS a v5 file — and
 *  minting changes no derived guid, because derivation reads `localId`s.
 *
 *  ⚠️ This is a PREFAB rewrite, not a scene one. § 4 Phase 5 declines a scene corpus rewrite and
 *  declines it because scenes REFUSE to load a newer document; prefabs do not. The asymmetry is
 *  the whole reason one is safe and the other is not — do not read this script as a precedent for
 *  the other.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT_DIRS } from './projectRoots.mjs';
import { repoFiles } from './repoCorpus.mjs';
import { repoRoot } from './repoCorpus.mjs';

const ROOT = repoRoot();
const WRITE = process.argv.includes('--write');

// ⚠️ READ the version from source, never a literal: this script STAMPS the number it believes in,
// so a stale copy silently DOWNGRADES every file it rewrites. `migrate-anchor-zindex.mjs` sat at
// 13 through the v14 bump for exactly this reason (#1358), and carries the same warning.
const versionSrc = readFileSync(`${ROOT}/engine/packages/modoki/src/runtime/core/version.ts`, 'utf8');
const versionMatch = versionSrc.match(/PREFAB_FORMAT_VERSION\s*=\s*(\d+)/);
if (!versionMatch) {
  console.error('could not read PREFAB_FORMAT_VERSION from runtime/core/version.ts');
  process.exit(1);
}
const PREFAB_FORMAT_VERSION = Number(versionMatch[1]);

/** Insert one line into `raw` immediately after the unique line that `anchor` matches, at that
 *  line's own indentation, and return the new text — or `null` when the anchor does not match
 *  EXACTLY once.
 *
 *  ⚠️ This edits TEXT rather than re-serializing the parsed document, and the reason is the
 *  corpus: 10 of the 105 authored prefabs are HAND-written with compact one-line trait objects, so
 *  a `JSON.stringify(doc, null, 2)` rewrite would expand them and bury the migration's own 1811
 *  added lines under an unrelated reformat. Editing lines keeps every file's diff to exactly what
 *  this migration adds. What makes it safe is not the regex — it is `verify` below, which parses
 *  the result and compares it to the document this script MEANT to write, key order included. A
 *  surgery that lands anywhere unintended fails that comparison and the file is skipped. */
function insertAfter(raw, anchor, line) {
  const matches = raw.match(anchor);
  if (!matches || matches.length !== 1) return null;
  return raw.replace(anchor, (hit) => `${hit}\n${/^\s*/.exec(hit)[0]}${line}`);
}

// Every prefab the repo knows about, enumerated through GIT via the ONE shared corpus producer —
// a hand-rolled walk here is the violation `corpusProducerIsShared.test.ts` polices.
const allPrefabs = repoFiles({ match: /\.prefab\.json$/i, floor: 1 });
const PROJECT_PATTERN = new RegExp(`^(${PROJECT_ROOT_DIRS.join('|')})/[^/]+/runtime/assets/`, 'i');
const targets = allPrefabs.filter((f) => PROJECT_PATTERN.test(f.rel));

// ⚠️ An enumeration that returns NOTHING reports "0 files would be rewritten" and exits 0 —
// indistinguishable from a corpus that is already migrated, which is exactly how a silently
// broken walk presents. Report BOTH counts so the operator can tell "the pattern broke" (targets
// 0, enumerated > 0) from "git broke" (enumerated 0 too).
if (targets.length === 0) {
  console.error(`no prefabs matched ${PROJECT_PATTERN} (${allPrefabs.length} prefab file(s) enumerated repo-wide)`);
  process.exit(1);
}
// A prefab OUTSIDE a project's `runtime/assets` is not skipped quietly — it is either a new
// authoring location this pattern must learn, or a fixture that must stay pre-v5 on purpose. Name
// it either way.
const outside = allPrefabs.filter((f) => !PROJECT_PATTERN.test(f.rel));
if (outside.length > 0) {
  console.warn(`\n⚠️ ${outside.length} prefab(s) outside ${PROJECT_PATTERN} — NOT migrated:`);
  for (const f of outside) console.warn(`   ${f.rel}`);
}

let rewritten = 0;
let rowsMinted = 0;
let alreadyDone = 0;
const failed = [];
const seen = new Map(); // node guid → "file#localId", across the whole corpus

for (const { rel, abs } of targets) {
  const raw = readFileSync(abs, 'utf8');
  const doc = JSON.parse(raw);
  const rows = Array.isArray(doc.entities) ? doc.entities : [];
  const needs = rows.filter((r) => !r.nodeGuid).length;
  if (needs === 0 && (doc.version ?? 0) >= PREFAB_FORMAT_VERSION) { alreadyDone++; continue; }

  // The document this script MEANS to write. `nodeGuid` is rebuilt into position rather than
  // assigned, so it sits where the serializer puts it — `{ localId, nodeGuid, name, traits }`.
  // Appending it after `traits` instead would leave the next real save to move it, and that move
  // would land as a diff nobody made.
  const minted = new Map();
  const intended = {
    ...doc,
    // `Math.max`, never a bare assignment: a format marker that can go BACKWARDS is worse than
    // none — see the `version` docblock in editor/scene/prefab.ts on the rule this replaced.
    version: Math.max(PREFAB_FORMAT_VERSION, doc.version ?? 0),
    entities: rows.map((row) => {
      if (row.nodeGuid) return row;
      const { localId, ...rest } = row;
      const nodeGuid = randomUUID();
      minted.set(localId, nodeGuid);
      return { localId, nodeGuid, ...rest };
    }),
  };

  let text = raw.replace(/"version":\s*\d+/, `"version": ${intended.version}`);
  let ok = true;
  for (const [localId, nodeGuid] of minted) {
    const next = insertAfter(text, new RegExp(`^\\s*"localId": ${localId},?$`, 'm'), `"nodeGuid": "${nodeGuid}",`);
    if (next === null) { ok = false; break; }
    text = next;
  }

  // ⚠️ The surgery is not trusted — it is PROVEN, per file, before anything is written.
  // `JSON.stringify` compares values AND key order, which is the half a deep-equality check would
  // miss and the half that decides whether `nodeGuid` landed in the serializer's slot.
  const verify = () => { try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(intended); } catch { return false; } };
  if (!ok || !verify()) { failed.push(rel); continue; }

  for (const [localId, nodeGuid] of minted) {
    const at = `${rel}#${localId}`;
    const other = seen.get(nodeGuid);
    if (other) { console.error(`COLLISION: node guid ${nodeGuid} claimed by ${other} and ${at}`); process.exit(1); }
    seen.set(nodeGuid, at);
  }

  rewritten++;
  rowsMinted += minted.size;
  console.log(`${WRITE ? 'rewrote' : 'would rewrite'} ${rel} — v${intended.version}, ${minted.size} node guid(s)`);
  if (WRITE) writeFileSync(abs, text);
}

console.log(`\n${rowsMinted} node guid(s) across ${rewritten} prefab(s)`
  + `${WRITE ? ' written' : ' would be written (dry run — pass --write)'};`
  + ` ${alreadyDone} already at v${PREFAB_FORMAT_VERSION}.`);
if (failed.length > 0) {
  console.error(`\n⚠️ SKIPPED — the line surgery did not reproduce the intended document:`);
  for (const rel of failed) console.error(`   ${rel}`);
  process.exitCode = 1;
}
