/** Committed scenes must stay in the CURRENT serializer's shape.
 *
 *  Background: a scene committed before the v9→v12 migrations stays on disk in its old,
 *  verbose form until something re-saves it — the loader migrates in memory, so nothing
 *  forces the issue. The cost is sha churn: the first incidental save rewrites the whole
 *  file and a one-line edit arrives as a 700-line diff. 48 scenes were migrated repo-wide on
 *  2026-08-04 (docs/scene-loading.md § "Re-saving legacy scenes").
 *
 *  This guard exists because that migration is not self-sustaining. Two ways it silently
 *  regresses, one of which had ALREADY happened and was found only by sweeping for it:
 *
 *   1. `engine/templates/starter` — the scaffolder template seeds EVERY new project
 *      (`scaffold-project.mjs` and the editor's File → New Project). It was stamped
 *      `"version": 12` while still carrying v11-era per-entity `id` fields, so every project
 *      ever created from it started life needing a re-save. Migrating 48 scenes by hand fixes
 *      the past; only a guard on the template fixes the future.
 *   2. A hand-edited or hand-authored scene can reintroduce the legacy shape at any time.
 *
 *  SCOPE / HONESTY: these are legacy-shape MARKERS, not a proof of full canonicality. A true
 *  check would re-serialize every scene and diff, which needs the trait schemas (and a world).
 *  The markers below are the ones the v11→v12 step and default-compaction remove, so they
 *  catch the realistic regressions cheaply. A scene can pass here and still not be byte-exact;
 *  `engine/scripts/check-scene-churn.mjs` is what verifies a real re-save.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasInternalGames } from '../helpers/repoLayout';

const REPO = path.resolve(__dirname, '../../..');
const hasGames = hasInternalGames();

/** Scenes that ship or seed new work. The test fixture under `engine/tests/fixtures/` is
 *  deliberately excluded: it sits outside PROJECT_ROOT_DIRS by design (see its CLAUDE.md),
 *  nothing reads its scene (only its animset), and it never reaches a user. */
function sceneFiles(): string[] {
  const out: string[] = [];
  const roots = ['games', 'demos'];
  for (const root of roots) {
    const base = path.join(REPO, root);
    if (!fs.existsSync(base)) continue;
    for (const proj of fs.readdirSync(base)) {
      const dir = path.join(base, proj, 'runtime/assets/scenes');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.scene.json')) out.push(path.join(dir, f));
    }
  }
  const tpl = path.join(REPO, 'engine/templates/starter/runtime/assets/scenes');
  if (fs.existsSync(tpl)) {
    for (const f of fs.readdirSync(tpl)) if (f.endsWith('.scene.json')) out.push(path.join(tpl, f));
  }
  return out;
}

/** Scenes knowingly left on the legacy shape, each with the reason and the issue tracking it.
 *  Two-way, like `authoredAssetRefs.test.ts`'s BASELINE: a NEW legacy scene fails, and an entry
 *  that stops firing also fails (so the list cannot outlive the exceptions it documents). */
const BASELINE: { file: string; why: string }[] = [
  // EMPTY, and that is the two-way check working rather than a list nobody maintained.
  // `games/chess/…/chess.scene.json` sat here because save-all baked its ~70 runtime-spawned
  // entities into the file (#124) — but #124 is CLOSED: an entity spawned from inside a system
  // tick is tagged `Transient` at the spawn site and never serialized, and chess's projection
  // opts into `pauseWhileStopped` so a stopped-mode system cannot rewrite authored state either.
  // The scene was re-saved in #268 and measured across the round trip: 83 entities before, 83
  // after, none added or removed, `version` 9 -> 12 the only content change. So the exemption had
  // outlived its exception, and this test said so — which is the whole point of failing on an
  // entry that stops firing.
];

/** The markers the current serializer never writes.
 *
 *  Inspects PARSED top-level `entities[].traits` only — deliberately not a raw-text scan. A
 *  text scan false-positives on prefab `added[]` subtrees, which are structural additions and
 *  carry their trait data in FULL (defaults and blank refs included) rather than being
 *  compacted. Measured: 3d-test/skinned-test.scene.json is correctly canonical yet contains
 *  two `"isVisible": true` / `"isActive": true` occurrences inside one such subtree, plus a
 *  surviving `"material": ""`. Scanning text flagged a migrated scene as legacy. */
function legacyMarkers(file: string): string[] {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const found: string[] = [];
  const entities: Array<Record<string, unknown>> = data.entities ?? [];
  // v11→v12 stopped writing the per-entity ecs id entirely.
  const withId = entities.filter((e) => typeof e.id === 'number').length;
  if (withId) found.push(`${withId} entities carry a numeric "id" (v12 stopped writing it)`);
  // Default-valued fields are compacted OUT of a top-level trait. These two are the
  // highest-signal cases (both default true on the traits that own them).
  for (const marker of ['isActive', 'isVisible'] as const) {
    let n = 0;
    for (const e of entities) {
      for (const traitData of Object.values((e.traits ?? {}) as Record<string, unknown>)) {
        if (traitData && typeof traitData === 'object'
          && (traitData as Record<string, unknown>)[marker] === true) n++;
      }
    }
    if (n) found.push(`${n}× "${marker}": true on a top-level trait (a schema default — compacted out on save)`);
  }
  return found;
}

describe.skipIf(!hasGames)('committed scenes stay in the current serializer shape', () => {
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join('/');

  it('finds scenes to scan (sanity: the guard is actually looking)', () => {
    expect(sceneFiles().length).toBeGreaterThan(0);
  });

  it('no scene carries the legacy shape, except the documented baseline', () => {
    const baselined = new Set(BASELINE.map((b) => b.file));
    const offenders = sceneFiles()
      .filter((f) => !baselined.has(rel(f)))
      .map((f) => ({ file: rel(f), markers: legacyMarkers(f) }))
      .filter((r) => r.markers.length)
      .map((r) => `${r.file} → ${r.markers.join('; ')}`);
    expect(
      offenders,
      'This scene is on the pre-v12 shape, so the next save of it will rewrite the whole file '
        + 'and bury the real edit in churn. Re-save it through the editor '
        + '(engine/scripts/resave-scenes.sh <project>) and review with check-scene-churn.mjs — '
        + 'but NOT if the project spawns entities on load (#124). See docs/scene-loading.md '
        + '§ "Re-saving legacy scenes".',
    ).toEqual([]);
  });

  // The template seeds every future project, so a regression here is unbounded: it would put
  // every project created from that day on back onto the legacy shape.
  it('the scaffolder template is canonical (it seeds every new project)', () => {
    const tpl = path.join(REPO, 'engine/templates/starter/runtime/assets/scenes/main.scene.json');
    if (!fs.existsSync(tpl)) return; // template moved — the scan test above still covers scenes
    expect(legacyMarkers(tpl), 'engine/templates/starter is stamped with the current scene '
      + 'version but holds pre-v12 content, so every scaffolded project starts life needing a '
      + 're-save. Regenerate it by scaffolding a throwaway project, re-saving it through the '
      + 'editor, and copying the result back (the scaffolder re-mints the GUIDs).').toEqual([]);
  });

  it('every BASELINE entry still fires (no stale exemptions)', () => {
    const stale = BASELINE
      .filter((b) => {
        const abs = path.join(REPO, b.file);
        return !fs.existsSync(abs) || legacyMarkers(abs).length === 0;
      })
      .map((b) => b.file);
    expect(
      stale,
      'These scenes are baselined as knowingly-legacy but no longer are — either they were '
        + 'migrated (good: delete the entry, and close the issue it cites) or the file moved. A '
        + 'baseline that outlives its exceptions silently re-permits them.',
    ).toEqual([]);
  });
});
