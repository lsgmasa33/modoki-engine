// Semantic diff of every re-saved scene against its committed (HEAD) version — the review
// gate for `engine/scripts/resave-scenes.sh`.
//
// Usage: node engine/scripts/check-scene-churn.mjs games/sling demos/forest-camp
//
// Reports entities lost/gained, traits lost/gained, and non-default values changed.
// Pure format compaction (defaults omitted, the runtime `id` dropped) is the POINT of the
// re-save and is deliberately NOT reported — otherwise every scene would be flagged. That is
// also this gate's one remaining blind spot, and it is a deliberate trade: a field DISAPPEARING
// is indistinguishable here from default-compaction without the trait schemas, which is exactly
// what a plain node script does not have. `engine/tests/assets/runtimeOnlyFieldsOffDisk.test.ts`
// covers the other direction from the registry side.
//
// What to look for in the output:
//   NEW ENTITY ...        the game SPAWNED it on load and save-all baked it in (#124). Revert
//                         the scene; that project cannot be swept (measured: games/chess).
//   CHANGED <live value>  runtime state leaked into the file, same cause as above (#124;
//                         measured: a progress bar's width/text in games/chess + games/llm-test).
//   GAINED ...            a field the committed file did not spell out, which the re-save now
//                         emits — so it no longer holds its schema default and something wrote a
//                         LIVE value onto authored data. Same class as CHANGED, and invisible
//                         here until #406 (see the loop below). Usually the fix is a missing
//                         `runtimeOnly: true` in engine/app/ecs/registerTraits.ts, not a revert.
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
import { execFileSync } from 'node:child_process';
import { isGitVerdict } from './gitError.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffResources, sceneBodyText } from './lib/resourceDiff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const key = (e) => e.traits?.EntityAttributes?.guid ?? 'name:' + e.name;

/** Fields a re-save legitimately WRITES where the committed file had none, so a gain is the
 *  migration working rather than a leak: `guid` is minted for a never-saved entity, `parentId` is
 *  guid-ified from a live id, and `rootInstanceId` is `entityId`-flagged so serialize emits it
 *  unconditionally.
 *  ⚠️ Keyed `Trait.field` deliberately — see the GAINED branch for what a trait-wide exemption
 *  swallowed. Any FUTURE `entityId`-flagged field is emitted unconditionally too and will report
 *  GAINED on the first legacy sweep that meets it; add it here rather than widening a key. */
const MINTED_FIELDS = new Set([
  'EntityAttributes.guid',
  'EntityAttributes.parentId',
  'PrefabInstance.rootInstanceId',
]);

let totalScenes = 0, totalChanged = 0, problems = 0, regressions = 0;

for (const proj of process.argv.slice(2)) {
  const dir = path.join(ROOT, proj, 'runtime/assets/scenes');
  if (!fs.existsSync(dir)) { console.log(`${proj}: no scenes dir`); continue; }
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.scene.json'))) {
    // POSIX-normalized: git addresses tree objects with FORWARD SLASHES on every OS, so a
    // `path.relative` result would make `git show HEAD:"<rel>"` throw on Windows for every
    // committed file — and the catch below reports that as "NEW FILE (untracked)", so the
    // whole review gate silently stops diffing. Same class as the importClosure fix (30c84cdc0).
    const rel = path.relative(ROOT, path.join(dir, f)).split(path.sep).join('/');
    totalScenes++;
    let old;
    // ⚠️ `maxBuffer`: Node defaults to 1 MiB, and the largest tracked scene is
    // already games/court's main.scene.json at 369,684 B — 35% of it, and up 2.5x in the
    // month to 2026-09-12. 64 MiB is the figure `repoCorpus.mjs` already uses for git reads.
    // ⚠️ `execFileSync` with an argv array, never `execSync` with a shell string. Two reasons, and
    // the first was found by review AFTER the #1120 fix landed: through a shell, a MISSING git
    // makes the shell exit 127 — a NUMERIC status — so `isGitVerdict` reads it as a verdict, the
    // throw is swallowed, and every committed file prints "NEW FILE (untracked)". That is the exact
    // silent-blind gate this fix exists to close, reintroduced by the fix. Without a shell the
    // failure is ENOENT with `status: null`, which is not a verdict. Second: no shell means no
    // quoting, which is the Windows hazard the note above records (`repoCorpus.mjs` § execSync).
    try { old = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) {
      // ⚠️ ONLY a completed-but-failed git run may be read as "this file is not in HEAD". A throw
      // with no numeric `status` means the process never returned a verdict at all — measured:
      // exceeding maxBuffer gives `code:'ENOBUFS', status:null`, while git saying no gives
      // `status:128`. Swallowing the first reported a long-committed scene as untracked and
      // SKIPPED ITS DIFF, so the review gate went blind on the largest file it has to read. That
      // is the same silent-stop this file's own note above already records for the Windows-quoting
      // cause (#1120).
      if (!isGitVerdict(e)) {
        throw new Error(`${rel}: \`git show\` did not complete (${e.code ?? e.message}) — refusing to `
          + 'report a committed file as untracked and skip its diff.', { cause: e });
      }
      console.log(`  ${rel}: NEW FILE (untracked)`); continue;
    }
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
          // A field the committed file did NOT spell out. The loader gave it the schema default,
          // so the only way the re-save emits it is that it no longer HOLDS the default — i.e.
          // something wrote a live value onto authored data. That is the #124 class, and this
          // gate was blind to it until #406: the loop only ever compared fields present in BOTH
          // versions, so a scroll-demo re-save that baked `UIScrollView.viewportWidth` 410 — the
          // live measurement of the editor's UI viewport — into three scenes reported
          // "0 semantic changes".
          //   The exemptions are per FIELD, not per trait, and that distinction is the whole
          // value of the check. Exempting all of `EntityAttributes` (the first version of this
          // did) also silences `isActive`, which the Director's activation track writes live
          // (`runtime/timeline/timelineSystem.ts` — `entity.set(EntityAttributes, { …, isActive })`).
          // A scene omits `isActive` because it defaults to true, so a Director sweep baking a
          // permanently-deactivated entity into the file lands as a GAIN — exactly the leak this
          // is for — and the trait-wide exemption printed "0 semantic changes" over it.
          if (ov === undefined && !MINTED_FIELDS.has(`${t}.${fl}`)) {
            notes.push(`GAINED ${ea.name}.${t}.${fl} = ${JSON.stringify(v)} (absent before, so this is a LIVE value written onto authored data)`);
            continue;
          }
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
