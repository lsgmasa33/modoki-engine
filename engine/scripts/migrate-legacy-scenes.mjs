#!/usr/bin/env node
/** Migrate legacy (v9/v10) scene files to the form the current editor's serializer writes — by
 *  DRIVING A RUNNING EDITOR (load-scene → save-all), then verifying every file it touched.
 *
 *      MODOKI_BACKEND=http://127.0.0.1:5181 node engine/scripts/migrate-legacy-scenes.mjs games/sling
 *      MODOKI_BACKEND=http://127.0.0.1:5181 node engine/scripts/migrate-legacy-scenes.mjs games/sling --apply
 *
 *  Dry-run by default (every change reverted after checking), `--apply` to keep the accepted files —
 *  the same shape as `scripts/publish-demo.sh`. The editor must already be running ON THIS PROJECT;
 *  a scene can only be loaded by the editor that has its project open, which is why this takes one
 *  project at a time rather than sweeping the repo.
 *
 *  ── STATE (2026-07-31) ───────────────────────────────────────────────────────────────────────
 *  The two blockers this banner used to carry are FIXED, and a save now SHRINKS a legacy scene
 *  instead of growing it:
 *    - trait DEFAULTS are no longer materialized into the file — `serialize.ts` omits a field
 *      still holding its default, so defaults stay live and a later change to one still reaches
 *      every migrated scene (the semantic objection that put the bulk migration on hold);
 *    - the `Time (resource)` entity SceneManager materializes is tagged `Transient`, so it is no
 *      longer inserted into whatever scene is saved next.
 *  Measured on `games/3d-test` right after: 5 of 7 accepted, up from 2 of 7. The two rejects are
 *  unrelated pre-existing issues: a prefab-override capture that drops a marked `Animator.clip`
 *  (see docs/prefabs.md), and structural `added` subtrees still writing defaults.
 *
 *  A bulk `--apply` across all 47 scenes is therefore now a reasonable thing to run — but it is
 *  still the OWNER's call, because 10 of those scenes live in PUBLISHED demos and the diff lands
 *  in three public repos on the next `publish-demo.sh`.
 *
 *  ── WHY IT DRIVES THE EDITOR RATHER THAN REWRITING TEXT ──────────────────────────────────────
 *  A hand-rolled transform was written and REJECTED by measurement: bumping `version` and dropping
 *  the redundant per-entity `id` reproduced the editor's output byte-for-byte except for
 *  `PrefabInstance.rootInstanceId`, which the serializer converts from a numeric entity id to that
 *  entity's GUID. Stripping the ids without it would DANGLE the prefab reference. And the set of
 *  fields needing that conversion is registry-driven (every `entityId`-flagged FieldHint, see
 *  `serialize.ts`), so restating it here would be the duplication conventions §9 warns about. The
 *  serializer is the only source of truth for its own output.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { backendUrlForClone } from './editorPorts.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const postTo = (backend) => async (path, body) => {
  const res = await fetch(`${backend}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/** A numeric entity ref became a GUID (or '' — serialize writes '' for an unset or dangling ref).
 *  The ONLY value change a migration may make.
 *
 *  DELIBERATELY LOOSE, and the reason is worth recording because the obvious tightening is WRONG.
 *  The natural stronger rule is "the new GUID must be the guid of the entity that held that id", so
 *  a ref silently REPOINTED at a different entity could not pass. It was implemented, and the real
 *  editor's own output failed it: for `tropical-island.json`, `rootInstanceId: 22` becomes
 *  `43d67a90-…`, while the entity with `id: 22` ("Island") has NO guid in the legacy file and that
 *  GUID appears nowhere in either version. `rootInstanceId` identifies the prefab INSTANCE, not an
 *  entity, and the serializer MINTS it on save. There is nothing in the old file to check it
 *  against, so int → GUID is the strongest honest rule here.
 *
 *  Recorded rather than silently reverted: the guard is only trustworthy if the limits of what it
 *  proves are written down. Lossy saves and default-materialization — the failures this exists to
 *  catch — are caught structurally elsewhere in `checkMigration`. */
const idBecameGuid = (old, next) =>
  isInt(old) && (next === '' || (typeof next === 'string' && GUID.test(next)));

/** `defaults` is the trait's field → scalar-default map (from `/api/trait-schema`) when this
 *  node IS a trait's field object, else null. Supplied so a field the serializer OMITTED
 *  because it still held its default is not mistaken for data loss — that omission is the
 *  point of the format (see `isTraitDefault` in serialize.ts), and treating it as lossy is
 *  what made this checker reject 5 of 7 `games/3d-test` scenes.
 *
 *  With no schema available every removal is reported, which is the safe direction: the
 *  checker over-reports rather than waving through a genuine loss. */
function walk(old, next, path, problems, defaults = null) {
  if (old && next && typeof old === 'object' && typeof next === 'object'
      && !Array.isArray(old) && !Array.isArray(next)) {
    for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (!(k in old)) problems.push(`${path}.${k}: ADDED (${JSON.stringify(next[k])})`);
      else if (!(k in next)) {
        // Omitted-because-default is lossless: the loader rebuilds it from the same schema.
        // `Object.is` mirrors serialize.ts exactly, so -0 and NaN agree with the serializer.
        if (defaults && k in defaults && Object.is(old[k], defaults[k])) continue;
        problems.push(`${path}.${k}: REMOVED (${JSON.stringify(old[k])})`);
      } else walk(old[k], next[k], `${path}.${k}`, problems);
    }
  } else if (Array.isArray(old) && Array.isArray(next)) {
    if (old.length !== next.length) problems.push(`${path}: list length ${old.length} -> ${next.length}`);
    else old.forEach((a, i) => walk(a, next[i], `${path}[${i}]`, problems));
  } else if (JSON.stringify(old) !== JSON.stringify(next) && !idBecameGuid(old, next)) {
    problems.push(`${path}: ${JSON.stringify(old)} -> ${JSON.stringify(next)}`);
  }
}

/** Pair old/new entities by IDENTITY rather than array position.
 *
 *  A save can REORDER the array without changing anything semantic: `getAllEntities()`
 *  appends entities that carry no `EntityAttributes` — a resource singleton such as
 *  `Time (resource)` — in a second pass, so an authored Time sitting mid-file moves to the
 *  end. Positional comparison turned that single shift into ~40 phantom "field changed"
 *  lines and REJECTED a scene whose save was in fact lossless (measured on
 *  `material-instance-demo.json`, 2026-07-31). Array order is not semantic here: the loader
 *  uses the index only as a per-load synthetic key, and paint order comes from `sortOrder`.
 *
 *  Falls back to positional unless keys are unique on BOTH sides and every old key is
 *  present in the new — an ambiguous or genuinely-changed file is never quietly waved
 *  through. `movedCount` is reported by the CLI as a note; it is NOT a rejection, because a
 *  reorder loses nothing. */
export function pairEntities(oe, ne) {
  const keyOf = (e) => e?.guid ?? e?.traits?.EntityAttributes?.guid ?? `name:${e?.name ?? ''}`;
  const oKeys = oe.map(keyOf), nKeys = ne.map(keyOf);
  const byKey = new Map();
  ne.forEach((e, i) => { if (!byKey.has(nKeys[i])) byKey.set(nKeys[i], e); });
  const pairable = oe.length === ne.length
    && new Set(oKeys).size === oe.length && new Set(nKeys).size === ne.length
    && oKeys.every((k) => byKey.has(k));
  const movedCount = pairable ? oKeys.filter((k, i) => k !== nKeys[i]).length : 0;
  return { pairable, byKey, oKeys, movedCount };
}

/** Flatten `/api/trait-schema`'s payload to trait → field → scalar default, dropping fields
 *  that declare none (non-scalar defaults are never omitted by the serializer either). */
export function defaultsByTrait(schema) {
  const out = {};
  for (const [traitName, t] of Object.entries(schema?.traits ?? {})) {
    const fields = {};
    for (const [field, entry] of Object.entries(t?.fields ?? {})) {
      if (entry && 'default' in entry) fields[field] = entry.default;
    }
    out[traitName] = fields;
  }
  return out;
}

/** Accept a migrated scene only if the save changed NOTHING but the mechanical things: the
 *  `version` bump, the removed per-entity numeric `id`, an entity ref turning into a GUID,
 *  and a field OMITTED because it still held its trait default (needs `schema`; see `walk`).
 *  Entity reordering is likewise not a loss — see `pairEntities`.
 *
 *  This guard is the point of the script. Driving the editor is the only way to get canonical
 *  output, and it is also the risk: a scene that loads with warnings (a missing GLB, a trait the
 *  editor's schema lacks) can serialize back LOSSILY while the save reports success. It caught
 *  exactly that — `ui-focus-demo.json` came back with 10 entities instead of 9. */
export function checkMigration(old, next, schema) {
  const defaults = schema ? defaultsByTrait(schema) : null;
  const problems = [];
  for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (k === 'version' || k === 'entities') continue;
    if (JSON.stringify(old[k]) !== JSON.stringify(next[k])) {
      problems.push(`top-level ${k} changed`);
    }
  }
  if (next.version !== 12) problems.push(`version is ${JSON.stringify(next.version)}, expected 12`);

  const oe = old.entities ?? [], ne = next.entities ?? [];
  if (oe.length !== ne.length) {
    problems.push(`ENTITY COUNT ${oe.length} -> ${ne.length} (lossy save)`);
  } else {
    // Pair entities by IDENTITY, not array position. A save can REORDER the array without
    // changing anything semantic: `getAllEntities()` appends entities that have no
    // `EntityAttributes` — a resource singleton like `Time (resource)` — in a second pass,
    // so an authored Time sitting mid-file moves to the end. Positional comparison turned
    // that single shift into ~40 phantom "field changed" lines and rejected a scene whose
    // save was in fact lossless (measured on material-instance-demo.json). Array order is
    // not semantic: the loader only uses the index as a per-load synthetic key, and paint
    // order comes from `sortOrder`.
    //
    // The reorder is still REPORTED — just once, as itself, rather than as fake data loss.
    const { pairable, byKey, oKeys } = pairEntities(oe, ne);
    oe.forEach((a, i) => {
      const b = pairable ? byKey.get(oKeys[i]) : ne[i];
      if ('id' in b) problems.push(`entities[${i}] still has a numeric id`);
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (k === 'id') continue;
        if (!(k in a) || !(k in b)) problems.push(`entities[${i}].${k}: added/removed`);
        else if (k === 'traits') {
          // Descend per-TRAIT so each field object is walked with its OWN defaults —
          // the trait name is only knowable at this level.
          for (const t of new Set([...Object.keys(a.traits ?? {}), ...Object.keys(b.traits ?? {})])) {
            const p = `entities[${i}](${a.name}).traits.${t}`;
            if (!(t in (a.traits ?? {}))) problems.push(`${p}: ADDED`);
            else if (!(t in (b.traits ?? {}))) problems.push(`${p}: REMOVED`);
            else walk(a.traits[t], b.traits[t], p, problems, defaults?.[t] ?? null);
          }
        } else walk(a[k], b[k], `entities[${i}](${a.name}).${k}`, problems);
      }
    });
  }

  // HALF-MIGRATED: serialize.ts calls `PrefabInstance.rootInstanceId` "the last numeric on-disk
  // entity ref". Still numeric ⇒ this file did not come from the real serializer, and its prefab
  // reference dangles now that the numeric ids are gone. Named specifically because the full set of
  // `entityId`-flagged fields lives in the trait registry.
  (function scan(node, path) {
    if (Array.isArray(node)) node.forEach((v, i) => scan(v, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'rootInstanceId' && isInt(v)) problems.push(`${path}.${k} is still numeric (${v}) — not serializer output`);
        scan(v, `${path}.${k}`);
      }
    }
  })(next, 'new');

  return problems;
}

const isLegacy = (doc) =>
  (doc.version ?? 0) < 12 || (doc.entities ?? []).some((e) => 'id' in e);

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const committed = (p) => JSON.parse(git('show', `HEAD:${p}`));

/** The CLI. Kept behind a direct-execution check so `checkMigration` can be imported and tested —
 *  it is the safety-critical half, and a guard nobody has watched fail is not known to work
 *  (`engine/tests/plugins/migrateLegacyScenes.test.ts`). */
async function main() {
  // MODOKI_BACKEND used to default to a literal 'http://127.0.0.1:5179' — the HUB's pinned
  // port — so a bare run from a worker clone silently drove the HUB's editor over HTTP
  // instead of the caller's own (#349). Derive from the clone directory instead (this
  // script lives at engine/scripts/, two levels below the repo root); an unknown clone with
  // no explicit MODOKI_BACKEND gets a loud error rather than a wrong-clone default.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const BACKEND = (process.env.MODOKI_BACKEND || backendUrlForClone(repoRoot))?.replace(/\/$/, '');
  if (!BACKEND) {
    console.error(
      `[migrate-legacy-scenes] '${repoRoot}' is not a known clone and MODOKI_BACKEND is unset — ` +
        `refusing to guess which editor to drive. Set MODOKI_BACKEND=http://127.0.0.1:<port> explicitly.`,
    );
    process.exit(2);
  }
  const APPLY = process.argv.includes('--apply');
  const PROJECT = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const post = postTo(BACKEND);

  if (!PROJECT) {
    console.error('usage: MODOKI_BACKEND=http://127.0.0.1:<port> node engine/scripts/migrate-legacy-scenes.mjs <project-root> [--apply]');
    process.exit(2);
  }

  const scenes = git('ls-files', `${PROJECT}/runtime/assets/scenes/*.json`)
    .split('\n').filter(Boolean)
    .filter((f) => { try { return isLegacy(read(f)); } catch { return false; } });

  if (!scenes.length) {
    console.log(`[${PROJECT}] no legacy scenes — nothing to migrate`);
    process.exit(0);
  }

  const identity = await fetch(`${BACKEND}/api/identity`).then((r) => r.json()).catch(() => null);
  if (!identity) {
    console.error(`no editor backend at ${BACKEND} — launch one on this project first:\n`
      + `  MODOKI_BACKEND_PORT=<port> engine/scripts/launch-editor.sh ${PROJECT}`);
    process.exit(1);
  }
  if (!identity.projectRoot?.endsWith(PROJECT)) {
    // Driving the wrong project would silently do nothing (its scenes are not loadable) — the same
    // "which editor am I on?" trap `modoki_identity` exists for.
    console.error(`the editor on ${BACKEND} has ${identity.projectRoot} open, not ${PROJECT}. Relaunch it on this project.`);
    process.exit(1);
  }
  // Trait defaults, so the checker can tell "omitted because it equals the default"
  // (lossless, and the format's whole point) from a genuine loss. Fetched from the SAME
  // editor that does the saving, so the defaults are the ones its serializer actually used.
  const traitSchema = await fetch(`${BACKEND}/api/trait-schema`)
    .then((r) => r.json()).catch(() => null);
  if (!traitSchema?.schemaAvailable) {
    // Not fatal: without defaults every removal is reported, so the run over-reports
    // rather than passing a real loss. Say so, since the output would be confusing.
    console.warn('  ! no trait schema from the editor — default-omitted fields will be reported as REMOVED');
  }

  console.log(`[${PROJECT}] ${scenes.length} legacy scene(s) · ${APPLY ? 'APPLY' : 'dry-run'} · backend ${BACKEND}`);

  const accepted = [], rejected = [], skipped = [], notes = [];
  for (const file of scenes) {
    const rel = `/assets/scenes/${file.split('/').pop()}`;
    // Clear anything parked, so load-scene is never refused by leftover state from an earlier step.
    await post('/api/editor-action', { action: 'discard-asset-edits', all: true }).catch(() => {});
    const loaded = await post('/api/editor-action', { action: 'load-scene', path: rel, force: true });
    if (!loaded?.ok) { skipped.push([file, `load refused: ${loaded?.error ?? JSON.stringify(loaded)}`]); continue; }
    const saved = await post('/api/editor-action', { action: 'save-all' });
    if (!saved?.ok) { skipped.push([file, `save refused: ${saved?.error ?? JSON.stringify(saved)}`]); continue; }

    // Check EVERY scene file the save touched — save-all can also write dirty base scenes.
    for (const touched of git('diff', '--name-only', '--', PROJECT).split('\n').filter((f) => f.includes('/assets/scenes/'))) {
      const before = committed(touched), after = read(touched);
      const problems = checkMigration(before, after, traitSchema);
      // A pure reorder loses nothing, so it must not reject — but it IS a deviation from
      // "a no-op save is a no-op", so say it out loud rather than silently normalizing.
      const { movedCount } = pairEntities(before.entities ?? [], after.entities ?? []);
      if (movedCount) notes.push([touched, `${movedCount} entity/entities reordered (no data change)`]);
      if (problems.length) {
        rejected.push([touched, problems]);
        git('checkout', '--', touched);
      } else if (!accepted.includes(touched)) {
        accepted.push(touched);
      }
    }
  }

  console.log(`\n[${PROJECT}] accepted ${accepted.length} · rejected ${rejected.length} · skipped ${skipped.length}`);
  for (const f of accepted) console.log(`  OK      ${f}`);
  for (const [f, problems] of rejected) {
    console.log(`  REJECT  ${f}`);
    for (const p of problems.slice(0, 8)) console.log(`            ${p}`);
    if (problems.length > 8) console.log(`            … and ${problems.length - 8} more`);
  }
  for (const [f, why] of skipped) console.log(`  SKIP    ${f} — ${why}`);
  for (const [f, why] of notes) console.log(`  NOTE    ${f} — ${why}`);

  if (!APPLY && accepted.length) {
    git('checkout', '--', ...accepted);
    console.log(`\ndry-run: reverted ${accepted.length} accepted file(s). Re-run with --apply to keep them.`);
  }
  process.exit(rejected.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
