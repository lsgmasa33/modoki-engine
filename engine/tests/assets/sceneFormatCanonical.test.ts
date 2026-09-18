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
 *
 *  One slice of real canonicality IS affordable and lives in a sibling:
 *  `runtimeOnlyFieldsOffDisk.test.ts` fails on any committed scene or prefab holding a field the
 *  serializer would never emit. That direction needs only the trait registry's Inspector metadata
 *  — no world — and it is the direction that actually bit (#406).
 *
 *  ## The serializer's FIXED POINT, per trait object (#1412)
 *
 *  Two more slices need only the registry too, and they are the two that keep recurring. A
 *  committed trait object the serializer would write DIFFERENTLY is rewritten by the next save, so
 *  that save's diff buries its real edit under a content-neutral one:
 *   - **key order** — a SoA trait is written in `Object.keys(schema)` order. Hand-edited JSON, or a
 *     migration that appends a key, breaks it: #1177 (13 scenes), #1410 (Court's No Ads objects).
 *   - **default-valued fields** — a SoA scalar equal to its schema default is omitted (#406).
 *  Both are decided by `writtenTraitKeys`/`isFieldWritten` (`editor/scene/traitDefault.ts`),
 *  the SAME functions `serializeScene` and prefab.ts's added-child writer call, so this guard cannot
 *  pass a serializer whose rule moved. SCOPE, and it is a real limit: `entities[].traits` on ENGINE
 *  SoA traits only. AoS traits (function schema: `SkinnedMeshRenderer`, `AnimationLibrary`,
 *  `MaterialInstance`, `Input`, `UIAction`) have no static key order, and game-registered traits are
 *  invisible to `registerAllTraits()` — the same limit `runtimeOnlyFieldsOffDisk` documents. Prefab
 *  `added[]` subtrees are left out on purpose: older ones were written uncompacted (see
 *  `legacyMarkersOf`), and a guard over them would fire on correct legacy content.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasInternalGames } from '../helpers/repoLayout';
import { SCENE_FORMAT_VERSION, getAllTraits, soaSchema } from '@modoki/engine/runtime';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { registerAllTraits } from '../../app/ecs/registerTraits';
// The LEAF module the serializer itself calls (import-free, so no editor graph comes with it).
import { isFieldWritten, traitKeyOrder } from '../../packages/modoki/src/editor/scene/traitDefault';

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

/* ⚠️ **No BASELINE list (#1140).** It was EMPTY since `games/chess/…/chess.scene.json` left it: that
 *  scene sat here because save-all baked its ~70 runtime-spawned entities into the file (#124), and
 *  #124 is CLOSED — an entity spawned from inside a system tick is tagged `Transient` at the spawn
 *  site and never serialized, and chess's projection opts into `pauseWhileStopped`. It was re-saved
 *  in #268 (83 entities before and after, `version` 9 -> 12 the only change), and the list's two-way
 *  check is what said the exemption had outlived its exception. An empty list's first row would
 *  pardon a whole scene; a scene that genuinely must stay legacy goes through
 *  `assertExemptionLedger`. With a clean-tree population of zero, `legacyMarkersOf` is pinned on
 *  synthetic data below. */

/** The markers the current serializer never writes.
 *
 *  Inspects PARSED top-level `entities[].traits` only — deliberately not a raw-text scan. A
 *  text scan false-positives on prefab `added[]` subtrees, which are structural additions and
 *  carry their trait data in FULL (defaults and blank refs included) rather than being
 *  compacted. Measured: 3d-test/skinned-test.scene.json is correctly canonical yet contains
 *  two `"isVisible": true` / `"isActive": true` occurrences inside one such subtree, plus a
 *  surviving `"material": ""`. Scanning text flagged a migrated scene as legacy. */
function legacyMarkers(file: string): string[] {
  return legacyMarkersOf(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function legacyMarkersOf(data: { entities?: Array<Record<string, unknown>> }): string[] {
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

  it('no scene carries the legacy shape', () => {
    const offenders = sceneFiles()
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
    // An assertion, not the early return it replaced (#1071): the template is TRACKED and ships in
    // every checkout, so its absence is a move — and the scan above only reads the template dir
    // when it exists, so "the scan still covers scenes" did not cover this one.
    expect(fs.existsSync(tpl), 'engine/templates/starter moved — repoint this guard').toBe(true);
    expect(legacyMarkers(tpl), 'engine/templates/starter is stamped with the current scene '
      + 'version but holds pre-v12 content, so every scaffolded project starts life needing a '
      + 're-save. Regenerate it by scaffolding a throwaway project, re-saving it through the '
      + 'editor, and copying the result back (the scaffolder re-mints the GUIDs).').toEqual([]);
  });

  /** ⚠️ No guard compared `version` against the constant until #405, and that is exactly how a
   *  hand-authored version number ABOVE the constant once sat undetected in a committed scene: a
   *  number nothing emits yet. The loader only warns for a too-new file, into a console nobody
   *  reads in a test run, and the markers above are blind to it — so the first editor save
   *  "regressed" the hand-typed number back down and read as data loss in a bug report. (This was
   *  written when `SCENE_FORMAT_VERSION` was 12 and a v13 migration didn't exist yet — it has
   *  since been added, but the guard below is about ANY future gap between a hand-typed version
   *  and what the serializer actually emits, not that specific one.)
   *
   *  A version ABOVE the constant is the failure this catches: it is unreachable by the serializer,
   *  so it can only have been typed. BELOW is legitimate and deliberately allowed — that is just a
   *  scene the migration chain has not re-saved yet, which the markers above already police on
   *  their own terms. */
  it('no scene claims a version the engine cannot emit', () => {
    const tooNew = sceneFiles()
      .map((f) => ({ file: rel(f), v: JSON.parse(fs.readFileSync(f, 'utf8')).version as number }))
      .filter((r) => typeof r.v === 'number' && r.v > SCENE_FORMAT_VERSION)
      .map((r) => `${r.file} → version ${r.v}, but SCENE_FORMAT_VERSION is ${SCENE_FORMAT_VERSION}`);
    expect(
      tooNew,
      'A scene claims a format version newer than this engine emits, so it was hand-edited rather '
        + 'than saved. The loader only warns, and the next real save silently "downgrades" it — '
        + 'which reads as data loss in a diff. Either bump SCENE_FORMAT_VERSION with its migration '
        + 'step (runtime/core/version.ts + loadSceneFile.ts), or correct the file.',
    ).toEqual([]);
  });
});

// Outside the games gate on purpose: the classifier needs no scenes, and inside `skipIf(!hasGames)` the
// public snapshot would run nothing proving it still works.
describe('legacyMarkersOf', () => {
  it('the markers fire on each legacy shape and stay quiet on a canonical one (a clean tree reports zero either way)', () => {
    expect(legacyMarkersOf({ entities: [{ id: 3, traits: {} }] })).toHaveLength(1);
    expect(legacyMarkersOf({ entities: [{ traits: { Transform: { isActive: true } } }] })).toHaveLength(1);
    expect(legacyMarkersOf({ entities: [{ traits: { Renderable: { isVisible: true } } }] })).toHaveLength(1);
    expect(legacyMarkersOf({ entities: [{ guid: 'g', traits: { Renderable: { isVisible: false } } }] })).toEqual([]);
  });
});

// ─── #1412: the serializer's fixed point, per trait object ──────────────────────────────────────

interface TraitShape { order: string[]; schema: Record<string, unknown>; fields: Record<string, { runtimeOnly?: boolean; entityId?: unknown }> }

/** Engine SoA traits by name, from the same registry the serializer walks. */
function soaTraitShapes(): Map<string, TraitShape> {
  registerAllTraits();
  const out = new Map<string, TraitShape>();
  for (const meta of getAllTraits()) {
    const schema = soaSchema(meta);
    if (schema) out.set(meta.name, { order: traitKeyOrder(schema), schema, fields: meta.fields });
  }
  return out;
}

interface ShapeFindings {
  /** Trait objects examined (the ledger's `scanned` — the goal state is zero offenders). */
  scanned: number;
  /** One per trait object whose keys are not a subsequence of its schema order. */
  order: Array<{ item: string; site: string }>;
  /** One per field the serializer would OMIT as a schema default. */
  defaults: Array<{ item: string; site: string }>;
}

/** What the next save of this scene would rewrite, per trait object. `item` keys an occurrence as
 *  `file::entity::Trait` (order) or `file::entity::Trait.field` (default) — entity by its durable
 *  guid, else its name. Pure, so the synthetic tests below pin it without any committed scene. */
function serializerShapeFindings(
  data: { entities?: Array<Record<string, unknown>> },
  file: string,
  shapes: Map<string, TraitShape>,
): ShapeFindings {
  const found: ShapeFindings = { scanned: 0, order: [], defaults: [] };
  for (const e of data.entities ?? []) {
    const traits = (e.traits ?? {}) as Record<string, unknown>;
    const ea = traits.EntityAttributes as Record<string, unknown> | undefined;
    const who = (typeof ea?.guid === 'string' && ea.guid) || String(e.name ?? '?');
    for (const [name, obj] of Object.entries(traits)) {
      const shape = shapes.get(name);
      if (!shape || !obj || typeof obj !== 'object') continue;
      found.scanned++;
      const bag = obj as Record<string, unknown>;
      const keys = Object.keys(bag);
      const positions = keys.map((k) => shape.order.indexOf(k)).filter((i) => i >= 0);
      if (positions.some((p, i) => i > 0 && p < positions[i - 1])) {
        found.order.push({ item: `${file}::${who}::${name}`, site: `${file}: ${e.name} ${name} {${keys.join(', ')}}` });
      }
      for (const k of keys) {
        if (!(k in shape.schema)) continue;
        // runtimeOnly is runtimeOnlyFieldsOffDisk's ban — one ledger per ban (#1123), not two here.
        if (shape.fields[k]?.runtimeOnly) continue;
        if (!isFieldWritten(bag[k], shape.schema, k, shape.fields[k])) {
          found.defaults.push({ item: `${file}::${who}::${name}.${k}`, site: `${file}: ${e.name} ${name}.${k} = ${JSON.stringify(bag[k])}` });
        }
      }
    }
  }
  return found;
}

describe.skipIf(!hasGames)('committed scenes are the serializer\'s fixed point (#1412)', () => {
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join('/');
  const shapes = soaTraitShapes();
  const all: ShapeFindings = { scanned: 0, order: [], defaults: [] };
  for (const f of sceneFiles()) {
    const r = serializerShapeFindings(JSON.parse(fs.readFileSync(f, 'utf8')), rel(f), shapes);
    all.scanned += r.scanned; all.order.push(...r.order); all.defaults.push(...r.defaults);
  }
  const RESAVE = 'Re-save the scene through the editor (engine/scripts/resave-scenes.sh <project>, or '
    + 'open it and Cmd+S) and review the diff with check-scene-churn.mjs. Never hand-edit a scene\'s '
    + 'JSON: this is what a hand edit leaves behind, and the next person\'s save pays for it.';

  it('every engine SoA trait object lists its keys in the serializer\'s order', () => {
    assertExemptionLedger({
      label: 'trait-object key order in sceneFormatCanonical',
      population: all.order,
      // No rows, and none should be added: new drift gets a re-save, never a pardon. The 8 objects
      // found when this guard landed (Court's No Ads UI, #1410; wordweave's ad-break UI; the #1398
      // Player ID row) were canonicalized in the same change, values unchanged. A per-object ledger
      // was tried first and dropped: other clones re-save or re-edit these scenes, so its rows went
      // stale (over-blessed) or short at whichever merge came second.
      exempt: [],
      floor: 500,
      scanned: all.scanned,
      fix: RESAVE,
    });
  });

  it('no committed field holds the schema default the serializer would omit (#406)', () => {
    assertExemptionLedger({
      label: 'default-valued trait fields in sceneFormatCanonical',
      population: all.defaults,
      floor: 500,
      scanned: all.scanned,
      fix: RESAVE,
    });
  });
});

// Outside the games gate, like `legacyMarkersOf`'s: the public snapshot must still prove the
// detector works, and a clean tree reports zero either way.
describe('serializerShapeFindings', () => {
  const shapes = soaTraitShapes();
  const t = shapes.get('Transform')!;
  const [k0, k1] = t.order;

  it('reads the order and the defaults from the registry (sanity: Transform is SoA with a numeric default)', () => {
    expect(t.order.length).toBeGreaterThan(2);
    expect(typeof t.schema[k0]).toBe('number');
  });

  it('flags a trait object whose keys are out of schema order, and not one in order', () => {
    const bad = serializerShapeFindings({ entities: [{ name: 'E', traits: { Transform: { [k1]: 5, [k0]: 5 } } }] }, 'f', shapes);
    expect(bad.order.map((o) => o.item)).toEqual(['f::E::Transform']);
    const good = serializerShapeFindings({ entities: [{ name: 'E', traits: { Transform: { [k0]: 5, [k1]: 5 } } }] }, 'f', shapes);
    expect(good.order).toEqual([]);
  });

  it('flags a scalar field equal to its schema default, and not a non-default value', () => {
    const def = t.schema[k0] as number;
    const bad = serializerShapeFindings({ entities: [{ name: 'E', traits: { Transform: { [k0]: def } } }] }, 'f', shapes);
    expect(bad.defaults.map((d) => d.item)).toEqual([`f::E::Transform.${k0}`]);
    const good = serializerShapeFindings({ entities: [{ name: 'E', traits: { Transform: { [k0]: def + 1 } } }] }, 'f', shapes);
    expect(good.defaults).toEqual([]);
  });

  it('never flags an entityId field at its default (the serializer always writes those) nor an unregistered trait', () => {
    // EntityAttributes.parentId is the entityId field every scene carries, written as '' for root.
    const r = serializerShapeFindings({ entities: [{ name: 'E', traits: {
      EntityAttributes: { parentId: '' },
      NotARegisteredTrait: { b: 1, a: 0 },
    } }] }, 'f', shapes);
    expect(r.defaults).toEqual([]);
    expect(r.order).toEqual([]);
  });
});
