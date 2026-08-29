// Semantic diff of every re-saved prefab against its committed (HEAD) version — the review
// gate for `engine/scripts/resave-prefabs.sh` (#125).
//
// Usage: node engine/scripts/check-prefab-churn.mjs games/sling demos/forest-camp
//
// The prefab sibling of check-scene-churn.mjs. Reports entities lost/gained, traits
// lost/gained, non-default values changed, and any change to a NESTED-INSTANCE row's
// structure. Pure format compaction (a blank-string field the writer now omits, a default
// value elided) is the POINT of the re-save and is deliberately NOT reported — otherwise
// every prefab would be flagged.
//
// What to look for in the output:
//   LOST ENTITY ...       a member vanished from the template. Never expected: revert.
//   NEW ENTITY ...        something was in the edit world that isn't authored — the scaffold
//                         lights/HDR leaking in, or a stopped-mode system spawn (#124).
//   LOST TRAIT ...        a component dropped off a member. Never expected: revert.
//   CHANGED <value>       an authored value moved. A stopped-mode system wrote to the prefab
//                         world (#124's mutation half, which no Transient tag can reach) —
//                         the editor console carries the save-time warning naming the field.
//   GAINED <value>        a field the committed file did not spell out, which the writer now
//                         emits — so it no longer holds its default. Same cause as CHANGED, and
//                         invisible here until #406. Often a missing `runtimeOnly: true` in
//                         engine/app/ecs/registerTraits.ts (`hidden` does NOT keep a field off
//                         disk); the GLB-wrapper prefabs under models//rigs//ships/ are the
//                         Animator/SkeletalAnimator carriers, so they are where to expect it.
//   NESTED <field>        the nested-instance row's prefab ref / overrides / added / removed
//                         changed. This is the one class the re-save can genuinely REGRESS:
//                         a nested child that wasn't cached at serialize time FLATTENS
//                         instead of round-tripping as a reference (serializePrefab warns
//                         "not cached; flattening instead of referencing"). Treated as a
//                         regression (exit 1) when a `prefab` ref is LOST.
//
/** Fields `serializePrefab` writes for every row regardless of the committed file, so a gain is
 *  the writer working rather than a leak: it emits `EntityAttributes` inline as
 *  `{ name, parentId, guid: '' }` with parentId remapped into the template's localId space
 *  (editor/scene/prefab.ts). Keyed `Trait.field`, NOT trait-wide — the scene gate's trait-wide
 *  version of this list silenced `EntityAttributes.isActive`, which the Director writes live.
 *  The scene sibling exempts `PrefabInstance.rootInstanceId` too; a template carries no instance
 *  row, so it is deliberately absent here rather than copied across. */
const MINTED_FIELDS = new Set([
  'EntityAttributes.name',
  'EntityAttributes.parentId',
  'EntityAttributes.guid',
]);

// Why keyed by localId and not by name: a prefab has no entity GUIDs — serializePrefab
// clears them (the template is not an instance). localId is the template's own stable
// address and the space its parentId/overrides/removed fields are written in, so it is the
// only key that survives a re-serialize. Names are not unique within a prefab.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every .prefab.json under a project, excluding build/native output. */
function findPrefabs(projDir) {
  const out = [];
  const skip = new Set(['node_modules', 'dist', 'build', 'ios', 'android', 'ads', '.git']);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.prefab.json')) out.push(path.join(dir, e.name));
    }
  };
  walk(projDir);
  return out.sort();
}

const NESTED_FIELDS = ['prefab', 'overrides', 'added', 'removed', 'removedTraits', 'nestedOverrides'];

let totalPrefabs = 0, totalChanged = 0, problems = 0, regressions = 0;

for (const proj of process.argv.slice(2)) {
  const dir = path.join(ROOT, proj);
  if (!fs.existsSync(dir)) { console.log(`${proj}: no such project`); continue; }
  const files = findPrefabs(dir);
  if (!files.length) { console.log(`${proj}: no prefabs`); continue; }

  for (const abs of files) {
    // POSIX-normalized — see check-scene-churn.mjs: git tree paths are forward-slash on every
    // OS, so an un-normalized rel makes every `git show` throw on Windows and every committed
    // prefab report as "NEW FILE (untracked)".
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    totalPrefabs++;
    let old;
    try { old = execSync(`git show HEAD:"${rel}"`, { cwd: ROOT, encoding: 'utf8' }); }
    catch { console.log(`  ${rel}: NEW FILE (untracked)`); continue; }
    const cur = fs.readFileSync(abs, 'utf8');
    if (old === cur) continue;
    totalChanged++;

    let a, b;
    try { a = JSON.parse(old); b = JSON.parse(cur); }
    catch (e) { console.log(`  ${rel}: UNPARSEABLE (${e.message})`); problems++; regressions++; continue; }

    const notes = [];
    // The prefab's own identity fields. A changed `id` is a dangling-ref bug: every scene that
    // instantiates this prefab addresses it by that GUID (modoki-asset-authoring gotcha).
    if (a.id !== b.id) { notes.push(`⚠️ REGRESSION: prefab id ${JSON.stringify(a.id)} -> ${JSON.stringify(b.id)} — every scene referencing this prefab now dangles`); regressions++; }
    if (a.name !== b.name) notes.push(`CHANGED name ${JSON.stringify(a.name)} -> ${JSON.stringify(b.name)}`);
    if (a.rootLocalId !== b.rootLocalId) notes.push(`CHANGED rootLocalId ${a.rootLocalId} -> ${b.rootLocalId}`);

    const A = new Map((a.entities || []).map((e) => [e.localId, e]));
    const B = new Map((b.entities || []).map((e) => [e.localId, e]));
    for (const [k, ea] of A) if (!B.has(k)) notes.push(`LOST ENTITY ${ea.name} (localId ${k})`);
    for (const [k, eb] of B) if (!A.has(k)) notes.push(`NEW ENTITY ${eb.name} (localId ${k})`);

    for (const [k, ea] of A) {
      const eb = B.get(k);
      if (!eb) continue;
      const who = `${ea.name}#${k}`;
      if (ea.name !== eb.name) notes.push(`CHANGED ${who}.name -> ${JSON.stringify(eb.name)}`);

      for (const t of Object.keys(ea.traits || {})) if (!(t in (eb.traits || {}))) notes.push(`LOST TRAIT ${who}.${t}`);
      for (const t of Object.keys(eb.traits || {})) {
        if (!(t in (ea.traits || {}))) { notes.push(`NEW TRAIT ${who}.${t}`); continue; }
        const av = ea.traits[t], bv = eb.traits[t];
        // A tag trait serializes as `true`, not a field bag — compare it whole.
        if (typeof av !== 'object' || typeof bv !== 'object' || av === null || bv === null) {
          if (JSON.stringify(av) !== JSON.stringify(bv)) notes.push(`CHANGED ${who}.${t} ${JSON.stringify(av)} -> ${JSON.stringify(bv)}`);
          continue;
        }
        // A field the new writer OMITS is compaction — the point of the sweep, not reported.
        // A field it ADDS is not. That direction used to be waved off here as "a default made
        // explicit", and #406 disproved it on the scene side: the writer compacts defaults, so a
        // field it emits where the committed file had none can only be there because it no longer
        // HOLDS its default — i.e. something wrote a live value onto authored data. The scene
        // gate's silence on exactly this shape is how a re-save baked the editor's measured
        // viewport into three committed scenes while reporting "0 semantic changes".
        for (const [fl, ov] of Object.entries(av)) {
          if (!(fl in bv)) continue;
          if (JSON.stringify(ov) !== JSON.stringify(bv[fl])) {
            notes.push(`CHANGED ${who}.${t}.${fl} ${JSON.stringify(ov)} -> ${JSON.stringify(bv[fl])}`);
          }
        }
        for (const fl of Object.keys(bv)) {
          if (fl in av || MINTED_FIELDS.has(`${t}.${fl}`)) continue;
          notes.push(`GAINED ${who}.${t}.${fl} = ${JSON.stringify(bv[fl])} (absent before, so this is a LIVE value written onto authored data)`);
        }
      }

      // Nested-instance structure. Unlike a trait bag, NOTHING here is compaction — every one
      // of these fields is authored structure, so any change is worth a human's eye, and a
      // LOST `prefab` ref means the nested child flattened into the parent template.
      for (const f of NESTED_FIELDS) {
        const av = JSON.stringify(ea[f]), bv = JSON.stringify(eb[f]);
        if (av === bv) continue;
        if (f === 'prefab' && ea[f] !== undefined && eb[f] === undefined) {
          notes.push(`⚠️ REGRESSION: NESTED ${who}.prefab LOST (${ea[f]}) — the child prefab was not cached at serialize time and FLATTENED into this template`);
          regressions++;
        } else {
          notes.push(`NESTED ${who}.${f} ${av ?? 'absent'} -> ${bv ?? 'absent'}`);
        }
      }
    }

    if (notes.length) { problems++; console.log(`  ${rel}:`); for (const n of notes) console.log(`    ${n}`); }
  }
}

console.log(`\nprefabs: ${totalPrefabs}  rewritten: ${totalChanged}  with semantic changes: ${problems}`);
// Exit non-zero only for the unambiguous cases: a re-minted prefab id (every referencing scene
// dangles) and a flattened nested instance (authored structure destroyed). Everything else
// printed is for a human to weigh. Safe to fail — this is a hand-run review gate, nothing
// invokes it programmatically.
if (regressions) {
  console.error(`\n⚠️  ${regressions} regression(s) — do NOT stage this.`);
  process.exit(1);
}
