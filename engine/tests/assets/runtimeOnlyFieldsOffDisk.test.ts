/** No committed scene or prefab may carry a `runtimeOnly` trait field.
 *
 *  `runtimeOnly` marks a field the ENGINE writes every frame — a measured viewport size, a scroll
 *  offset, a solver read-back, a one-shot request the renderer consumes. `serializeScene` skips
 *  them, so such a field on disk means one of two things, and both are bugs:
 *
 *   1. It was hand-authored, and the next save silently deletes it (it reads as data loss).
 *   2. The field is NOT marked `runtimeOnly` and a save baked a live measurement into authored
 *      data — which is what #406 found. `UIScrollView.viewportWidth/Height` and
 *      `contentWidth/Height` were marked `hidden` only; `hidden` is an Inspector-display flag and
 *      the serializer does not read it. A `games/scroll-demo` re-save wrote 410x312 — the editor's
 *      device-preview size — into three committed scenes, and `check-scene-churn.mjs` called it
 *      "0 semantic changes" because its field loop only compares fields present in BOTH versions
 *      and so is blind to a field APPEARING. `games/court` authors two scroll views and ships, so
 *      the same save would have put a preview-sized measurement into a shipping scene.
 *
 *  This is the cheap half of the canonicality check `sceneFormatCanonical.test.ts` says it cannot
 *  afford: proving a scene is byte-exact needs a re-serialize (trait schemas AND a world), but
 *  proving no field on disk is one the serializer would never emit needs only the registry's
 *  Inspector metadata — which `registerAllTraits()` gives a plain vitest run.
 *
 *  ⚠️ SCOPE: **engine traits only.** `registerAllTraits()` is all this test can cheaply call, so a
 *  GAME's own trait is invisible here — `games/sling`'s `Enemy.hpBarId` is `runtimeOnly` and is
 *  registered by `registerSlingSystems()`, which only that game's runtime calls. A save baking
 *  `hpBarId` into one of sling's prefabs passes this guard (checked: it is not on disk today).
 *  Registering every game's traits would mean importing game runtimes into an engine test, which
 *  the portability rule is against; the honest fix is knowing the limit, not widening the claim.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getAllTraits } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { REPO_ROOT } from '../helpers/repoLayout';

/** trait name → the set of its fields flagged `runtimeOnly` in the Inspector metadata. */
function runtimeOnlyByTrait(): Map<string, Set<string>> {
  registerAllTraits();
  const out = new Map<string, Set<string>>();
  for (const meta of getAllTraits()) {
    const fields = (meta.fields ?? {}) as Record<string, { runtimeOnly?: boolean } | undefined>;
    const flagged = Object.keys(fields).filter((f) => fields[f]?.runtimeOnly);
    if (flagged.length) out.set(meta.name, new Set(flagged));
  }
  return out;
}

/** Every committed authored file the serializer owns: scenes AND prefabs, across both project
 *  roots plus the scaffolder template (which seeds every future project, so a leak there is
 *  unbounded). Absent roots are skipped — the public snapshot ships the template and no games.
 *
 *  ⚠️ Enumerated by EXTENSION under each project's whole `runtime/assets` tree, not by a
 *  `scenes/` + `prefabs/` directory allowlist. A prefab does not have to live in `prefabs/`: 52 of
 *  the repo's 142 project scene/prefab files sit under `models/`, `rigs/`, `ships/`, `planets/` or
 *  `UI/`, and those are the GLB-wrapper prefabs — precisely the ones carrying `Animator` and
 *  `SkeletalAnimator`, whose read-back fields (`activeClip`, `time`, `normalizedTime`, `weight`)
 *  are flagged. A directory allowlist reached 63% of the corpus and missed the third where the
 *  flagged traits actually live. */
function authoredFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.scene.json') || e.name.endsWith('.prefab.json')) out.push(p);
    }
  };
  for (const root of ['games', 'demos']) {
    const base = path.join(REPO_ROOT, root);
    if (!fs.existsSync(base)) continue;
    for (const proj of fs.readdirSync(base)) walk(path.join(base, proj, 'runtime/assets'));
  }
  walk(path.join(REPO_ROOT, 'engine/templates/starter/runtime/assets'));
  return out;
}

/** Walk the whole parsed file rather than only `entities[].traits`.
 *
 *  Trait data reaches disk through THREE shapes — a plain entity's `traits`, a prefab instance's
 *  `overrides[localId][Trait]`, and an `added[]` subtree's own entities — and an override map is
 *  precisely where a leak would hide, since that is what a scene writes when an instance's live
 *  value diverges from its prefab. Keying on "an object whose key is a registered trait name and
 *  whose value is an object" reaches all three with no per-shape list to keep in sync. */
function offenders(file: string, flagged: Map<string, Set<string>>): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const fields = flagged.get(k);
      if (fields && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const f of Object.keys(v as Record<string, unknown>)) {
          if (fields.has(f)) found.push(`${k}.${f}`);
        }
      }
      walk(v);
    }
  };
  walk(JSON.parse(fs.readFileSync(file, 'utf8')));
  return [...new Set(found)].sort();
}

describe('runtimeOnly trait fields never reach disk', () => {
  const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join('/');

  it('finds authored files to scan (sanity: the guard is actually looking)', () => {
    // The scaffolder template ships in the public snapshot too, so this holds in both repos —
    // an empty scan here means the layout moved, not that everything is clean. Note what it does
    // NOT prove there: the snapshot has no games/ or demos/, so the scan is ONE template scene
    // that authors no UIScrollView at all. Real coverage of this guard is a private-repo fact.
    expect(authoredFiles().length).toBeGreaterThan(0);
  });

  it('knows which fields are runtimeOnly (sanity: the metadata actually loaded)', () => {
    // Without this, a registry that failed to load would make the scan below vacuously green —
    // zero flagged fields cannot flag anything. Named traits, not a count: a count drifts.
    const flagged = runtimeOnlyByTrait();
    expect(flagged.get('UIScrollView')).toContain('viewportWidth');
    expect(flagged.get('UIEntries')).toContain('poolSize');
    expect(flagged.get('Time')).toContain('elapsed');
  });

  it('no committed scene or prefab carries one', () => {
    const flagged = runtimeOnlyByTrait();
    const bad = authoredFiles()
      .map((f) => ({ file: rel(f), fields: offenders(f, flagged) }))
      .filter((r) => r.fields.length)
      .map((r) => `${r.file} → ${r.fields.join(', ')}`);
    expect(
      bad,
      'These files hold a field the serializer never writes, so either they were hand-authored '
        + '(and the next save deletes the field) or a live measurement was baked into authored '
        + 'data. Re-save the project through the editor (engine/scripts/resave-scenes.sh) and, if '
        + 'the field came back, the trait is missing `runtimeOnly: true` in '
        + 'engine/app/ecs/registerTraits.ts — `hidden: true` alone does NOT keep a field off disk.',
    ).toEqual([]);
  });
});
