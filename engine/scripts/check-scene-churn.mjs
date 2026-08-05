// Semantic diff of every re-saved scene against its committed (HEAD) version — the review
// gate for `engine/scripts/resave-scenes.sh`.
//
// Usage: node engine/scripts/check-scene-churn.mjs games/sling demos/forest-camp
//
// Reports entities lost/gained, traits lost/gained, and non-default values changed.
// Pure format compaction (defaults omitted, the runtime `id` dropped) is the POINT of the
// re-save and is deliberately NOT reported — otherwise every scene would be flagged.
//
// What to look for in the output:
//   NEW ENTITY ...        the game SPAWNED it on load and save-all baked it in (#124). Revert
//                         the scene; that project cannot be swept (measured: games/chess).
//   CHANGED <live value>  runtime state leaked into the file, same cause as above (#124;
//                         measured: a progress bar's width/text in games/chess + games/llm-test).
//   RESOURCE ADDED        normally a FIX: the committed manifest was missing an asset the
//                         scene references, so nothing preloaded or scene-refcounted it.
//   RESOURCE DROPPED      benign ONLY if the scene no longer references it. This script now
//                         answers that itself by scanning the new scene body for the ref, and
//                         calls the still-referenced case ⚠️ REGRESSION (exit 1).
//   RESOURCE RETYPED      same ref, different resource type — the acquire path changes with it.
//   parentId 0 -> ""      benign: a legacy numeric "no parent" normalizing to the GUID-era "".
//
// Resources are compared by IDENTITY, not by count. It used to report only `RESOURCES n -> m`,
// which is silent on a 1-for-1 swap — and that is not hypothetical: the games/space-invader
// re-save that closed #123 swapped a legacy page-texture GUID for the sprite GUID the scene
// actually references, and this gate said "0 semantic changes". A count is the one property a
// dropped ref can preserve while still being a drop.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffResources, sceneBodyText } from './lib/resourceDiff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const key = (e) => e.traits?.EntityAttributes?.guid ?? 'name:' + e.name;

let totalScenes = 0, totalChanged = 0, problems = 0, regressions = 0;

for (const proj of process.argv.slice(2)) {
  const dir = path.join(ROOT, proj, 'runtime/assets/scenes');
  if (!fs.existsSync(dir)) { console.log(`${proj}: no scenes dir`); continue; }
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.scene.json'))) {
    const rel = path.relative(ROOT, path.join(dir, f));
    totalScenes++;
    let old;
    try { old = execSync(`git show HEAD:"${rel}"`, { cwd: ROOT, encoding: 'utf8' }); }
    catch { console.log(`  ${rel}: NEW FILE (untracked)`); continue; }
    const cur = fs.readFileSync(path.join(dir, f), 'utf8');
    if (old === cur) continue;
    totalChanged++;

    const a = JSON.parse(old), b = JSON.parse(cur);
    const A = new Map((a.entities || []).map((e) => [key(e), e]));
    const B = new Map((b.entities || []).map((e) => [key(e), e]));
    const notes = [];
    for (const k of A.keys()) if (!B.has(k)) notes.push(`LOST ENTITY ${A.get(k).name}`);
    for (const k of B.keys()) if (!A.has(k)) notes.push(`NEW ENTITY ${B.get(k).name}`);
    for (const [k, ea] of A) {
      const eb = B.get(k); if (!eb) continue;
      for (const t of Object.keys(ea.traits || {})) if (!(t in (eb.traits || {}))) notes.push(`LOST TRAIT ${ea.name}.${t}`);
      for (const t of Object.keys(eb.traits || {})) {
        if (!(t in (ea.traits || {}))) { notes.push(`NEW TRAIT ${ea.name}.${t}`); continue; }
        for (const [fl, v] of Object.entries(eb.traits[t])) {
          const ov = ea.traits[t][fl];
          if (ov !== undefined && JSON.stringify(ov) !== JSON.stringify(v)) {
            notes.push(`CHANGED ${ea.name}.${t}.${fl} ${JSON.stringify(ov)} -> ${JSON.stringify(v)}`);
          }
        }
      }
    }
    // Resource manifest, compared by IDENTITY (see lib/resourceDiff.mjs for why not by count).
    for (const r of diffResources(a.resources, b.resources, sceneBodyText(b))) {
      notes.push(r.note);
      if (r.regression) regressions++;
    }

    // rootInstanceId runtime-id -> GUID is the EXPECTED A10 stability migration.
    const real = notes.filter((n) => !/CHANGED .*\.PrefabInstance\.rootInstanceId \d+ -> "/.test(n));
    if (real.length) { problems++; console.log(`  ${rel}:`); for (const n of real) console.log(`    ${n}`); }
  }
}
console.log(`\nscenes: ${totalScenes}  rewritten: ${totalChanged}  with semantic changes: ${problems}`);
// Exit non-zero ONLY for a dropped-but-still-referenced ref. Everything else this prints is
// for a human to weigh (an added resource is usually the re-save doing its job), but that one
// case is unambiguous: the file still points at an asset its own manifest no longer lists.
// Safe to fail: nothing invokes this programmatically — it is a hand-run review gate.
if (regressions) {
  console.error(`\n⚠️  ${regressions} dropped resource ref(s) still referenced by the scene — do NOT stage this.`);
  process.exit(1);
}
