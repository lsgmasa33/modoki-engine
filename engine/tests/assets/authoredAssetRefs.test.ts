/**
 * Invariant guard: an authored asset-ref FIELD must not be silently blank.
 *
 * This is the third guard in the #53 family. `codeAssetRefs.test.ts` closed the "GUID literal
 * in code" direction; #53's own migration pushed refs the OTHER way — off a code constant and
 * onto a resource-trait field authored in the scene. That trade has a cost the issue's close-out
 * comment measured directly: a code constant could never be empty, but an authored field CAN be
 * left blank, and nothing catches it. `assetRefIntegrity.test.ts` only rejects a DANGLING or
 * literal-path ref; an empty string is neither, so it sails through every existing test and
 * surfaces only in a real production build (the tree-shaker drops whatever nothing references) or
 * on device. See issue #53's close-out comment for the mutation check that found this.
 *
 * ── HOW A FIELD IS PROVEN TO BE AN ASSET REF ────────────────────────────────────────────
 * There is no static, node-loadable list of which (trait, field) pairs are asset refs — that
 * lives in `accept:` editor metadata, which is declared per-game in game source and isn't
 * reachable from here (and going down that road was explicitly rejected for #53). So this guard
 * derives it from the DATA instead: it walks every committed scene/prefab JSON under the real
 * asset roots, and for any (trait, field) pair where SOME instance anywhere in the repo holds a
 * value that is a GUID resolving to a real known asset, that pair is thereby PROVEN to be an
 * asset-ref field — nothing else could explain a real asset's GUID landing there. Every OTHER
 * instance of that same proven pair is then checked: an empty string is a blank ref.
 *
 * ── THE BASELINE ─────────────────────────────────────────────────────────────────────────
 * A blank asset ref is sometimes legitimate (an intentionally-empty material override slot, a
 * fallback-covered field). Rather than silently ignore those, they are PINNED in `BASELINE` below,
 * one entry per `file:trait.field`, with a two-way staleness check identical in spirit to
 * `codeAssetRefs.test.ts`'s `PENDING_MIGRATION`: a hit not in the baseline fails ("new blank"), and
 * a baseline entry that no longer hits also fails ("stale exemption"). The baseline is a RECORD of
 * what already existed when this guard landed, not a review or an approval — shrink it as blanks
 * get fixed, never grow it to make a new one quietly go away.
 *
 * NOTE (2026-08-04): 23 SCENE entries were dropped from the baseline in one go when every scene
 * was re-saved through the current serializer (`engine/scripts/resave-scenes.sh`). That pass
 * compacts default-valued fields OUT of the file, so a field authored as `"material": ""` is now
 * simply absent — and this guard only sees values that are present. Nothing actionable was lost:
 * every one of those entries was already an accepted exemption whose reason was "blank means use
 * the default, not a missing ref", which is exactly what an absent field means. The PREFAB entries
 * below still fire because prefabs were not part of that pass.
 *
 * NOTE (2026-08-06): prefabs HAVE now been re-saved (`engine/scripts/resave-prefabs.sh`, #125), and
 * the prediction the previous paragraph ended on — "expect the same shrink for the same reason" —
 * was WRONG, in the opposite direction. The prefab writer does not compact: `serializePrefab` reads
 * each trait's FULL persisted schema (`readTraitDataFull`) and writes every field, so a re-save
 * ADDS default-valued fields rather than removing them. Nothing shrank; two blank refs APPEARED
 * (`Renderable2D.material` on Game_Canvas + GreenSlim), pinned below. The scene and prefab writers
 * genuinely differ here, so do not reason about one from the other.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { findAssetRoots, readAssetGuid, detectType, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { hasInternalGames } from '../helpers/repoLayout';

// engine/tests/assets/ → repo root (games/ + demos/ live there).
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
// The public engine snapshot ships neither games/ nor demos/ — nothing to audit there.
const hasGames = hasInternalGames();
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuid = (s: unknown): s is string => typeof s === 'string' && GUID_RE.test(s);

/**
 * Pinned baseline of already-existing blank authored asset-ref fields, keyed `file:trait.field`
 * (the same collapsing granularity `codeAssetRefs.test.ts` uses for `PENDING_MIGRATION` — several
 * blank instances of the same pair in one file are one entry, not several). This is a BASELINE,
 * not an approval: each entry needs a reason a blank is acceptable there, same discipline as
 * `codeAssetRefs.test.ts`'s `ALLOWED`.
 *
 * Regenerate the candidate list with: MODOKI_DUMP_AUTHORED_ASSET_REFS=1 npx vitest run \
 *   --config engine/vite.config.ts engine/tests/assets/authoredAssetRefs.test.ts
 */
const BASELINE: { key: string; why: string }[] = [
  { key: '/games/3d-test/assets/models/skinned-test/capsule.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/3d-test/assets/models/skinned-test/cone.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/3d-test/assets/models/skinned-test/cylinder.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  // Renderable2D.sprite became a PROVEN ref pair only when the video work authored a video GUID
  // there — the first asset GUID in that field anywhere in the repo (every other 2D entity
  // uses a primitive keyword or a slice name). It was `games/video-test` that first proved it;
  // that fixture is deleted now, and `demos/video-demo`'s 2D video sprite keeps the pair proven.
  // This blank pre-dates all of it and is the 2D analogue
  // of the Renderable3DPrimitive.material entries below: a coloured quad, not a forgotten image.
  // (The SCENE blanks that came with it are gone for the reason in the 2026-08-04 note above —
  // the re-save compacted them out of the file.)
  { key: '/games/3d-test/assets/prefabs/Game_Canvas.prefab.json:Renderable2D.sprite', why: 'blank sprite = flat coloured primitive quad (Renderable2D.color + width/height), not a missing image' },
  // Both of these appeared in the 2026-08-06 PREFAB re-save (#125), for the reason in the note
  // above: the prefab writer emits the trait's FULL schema, so `material` — previously absent —
  // is now written as "". Same exemption as the Renderable3DPrimitive.material entries below.
  { key: '/games/3d-test/assets/prefabs/Game_Canvas.prefab.json:Renderable2D.material', why: 'optional 2D material override slot — blank means "use the default sprite material," not a forgotten material asset' },
  { key: '/games/alien-animal/assets/models/alien-animal.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/sling/assets/prefabs/bumper.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/bumper.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/cover-enemy.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/cover-enemy.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/enemy.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/enemy.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/goal-point.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  // Appeared in the 2026-08-06 prefab re-save (#125) — see the Game_Canvas.Renderable2D.material
  // entry above: the prefab writer emits the full trait schema, so this optional slot is now present.
  { key: '/games/sling/assets/prefabs/GreenSlim.prefab.json:Renderable2D.material', why: 'optional 2D material override slot — blank means "use the default sprite material," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/green-enemy.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/green-enemy.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/puck.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/puck.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/timeline-demo/assets/models/alien-animal.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/timeline-demo/assets/prefabs/spark.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/demos/forest-camp/assets/models/char_Ranger.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
];

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function urlFor(abs: string, roots: AssetRoot[]): string | null {
  for (const r of roots) {
    if (abs.startsWith(r.absDir + path.sep)) {
      return (r.urlPrefix + '/' + path.relative(r.absDir, abs).replace(/\\/g, '/')).normalize('NFC');
    }
  }
  return null;
}

/** Collect (path, type, abs) for every shippable asset under the real roots. Same shape as the
 *  duplicate in `assetRefIntegrity.test.ts` / `codeAssetRefs.test.ts` — kept independent on
 *  purpose rather than factored out, matching how those two already duplicate this walk rather
 *  than share a module. */
function collectAssets() {
  const roots = findAssetRoots(PROJECT_ROOT);
  const assets: { url: string; type: string; abs: string }[] = [];
  for (const r of roots) {
    for (const abs of walk(r.absDir)) {
      const url = urlFor(abs, roots);
      if (!url) continue;
      const ext = path.extname(url).toLowerCase();
      const type = detectType(url, ext);
      if (!type) continue;
      assets.push({ url, type, abs });
    }
  }
  return { roots, assets };
}

/** Every distinct GUID owned by a shipped asset (in-file id for JSON, sidecar id for binaries). */
function knownGuids(assets: { type: string; abs: string }[]): Set<string> {
  const set = new Set<string>();
  for (const a of assets) {
    const g = readAssetGuid(a.abs, a.type);
    if (g) set.add(g.toLowerCase());
  }
  return set;
}

const { assets } = collectAssets();
const sceneLike = assets.filter((a) => a.type === 'scene' || a.type === 'prefab');
const guids = knownGuids(assets);

interface FieldInstance {
  url: string;
  entity: string;
  trait: string;
  field: string;
  value: unknown;
}

/** One flat level of `{ traitName: { fieldName: value, ... }, ... }` — the shape shared by both
 *  an entity's own `traits` AND a prefab-instance's per-localId `overrides` entry. Traits whose
 *  value isn't a plain object (e.g. `RenderableUI: true`, or an array like `MaterialInstance`'s
 *  override list) have no field-level shape and are skipped — they can't hold a scalar asset ref. */
function* traitFields(url: string, entityLabel: string, traits: unknown): Generator<FieldInstance> {
  if (!traits || typeof traits !== 'object' || Array.isArray(traits)) return;
  for (const [trait, traitValue] of Object.entries(traits as Record<string, unknown>)) {
    if (!traitValue || typeof traitValue !== 'object' || Array.isArray(traitValue)) continue;
    for (const [field, value] of Object.entries(traitValue as Record<string, unknown>)) {
      yield { url, entity: entityLabel, trait, field, value };
    }
  }
}

/** Every (trait, field) instance across every entity in a scene/prefab file — its own `traits`,
 *  plus every prefab-instance override slot (`entity.overrides[localId] → { trait: { field } }`,
 *  see docs/prefab-structural-overrides.md). Both share the same trait→field→value shape. */
function collectFieldInstances(a: { url: string; abs: string }): FieldInstance[] {
  const json = JSON.parse(fs.readFileSync(a.abs, 'utf-8')) as {
    entities?: { name?: string; localId?: number; id?: number; traits?: unknown; overrides?: Record<string, unknown> }[];
  };
  const out: FieldInstance[] = [];
  for (const e of json.entities ?? []) {
    const label = e.name ?? String(e.localId ?? e.id ?? '?');
    out.push(...traitFields(a.url, label, e.traits));
    for (const [localId, ov] of Object.entries(e.overrides ?? {})) {
      out.push(...traitFields(a.url, `${label} (override of localId ${localId})`, ov));
    }
  }
  return out;
}

const allInstances = sceneLike.flatMap((a) => collectFieldInstances(a));

/** `trait.field` pairs PROVEN to be asset-ref fields: somewhere, some instance's value is a
 *  GUID that resolves to a real known asset. Only a real asset ref could explain that. */
const provenPairs = new Set(
  allInstances
    .filter((i) => isGuid(i.value) && guids.has((i.value as string).toLowerCase()))
    .map((i) => `${i.trait}.${i.field}`),
);

/** Ref pairs where a BLANK is the field's designed meaning, not an omission — exempted at the
 *  FIELD level rather than pinned per file in `BASELINE`.
 *
 *  The distinction is worth the extra mechanism. `BASELINE` records blanks that already existed
 *  and should shrink; an entry there is a debt. These are different: blank is what the field
 *  MEANS, so every future scene/prefab authoring the trait would fail this guard for doing the
 *  right thing, and the baseline would grow forever while catching nothing. A pair belongs here
 *  only when the blank has a defined behaviour the engine implements — not merely "it seems to
 *  work". Keep it short: a wrongly-listed pair silences the guard for that field repo-wide.
 *
 *  `UIElement.fontFamily` (#231): CSS `font-family` INHERITS, so a UI tree gets its typeface
 *  from one authored ancestor and every descendant is legitimately blank — of the 16 committed
 *  instances, 12 are blank and the 4 that are not are `games/wordweave`'s UI roots (`HUD Root`,
 *  `HelpModal`, `DictionaryModal`, `ResultModal`), all pointing at the same font guid. (Court used
 *  to be the one non-blank instance, on its `Intro` root; #803 moved Court's font onto
 *  `UISettings.fontFamily` instead — a different trait — so Court now contributes zero instances
 *  of this field, all blank.) Blank also has a documented fallback chain of its own (`systemFont`,
 *  then the browser default — `runtime/ui/fontFamilyRef.ts`). It became a "proven" pair the
 *  moment a root was first migrated from a family NAME to a GUID; nothing about the blanks
 *  changed. */
const OPTIONAL_BLANK_PAIRS = new Set(['UIElement.fontFamily']);

/** Every instance of a proven asset-ref pair whose value is a blank string. */
const blanks = allInstances.filter(
  (i) => provenPairs.has(`${i.trait}.${i.field}`)
    && !OPTIONAL_BLANK_PAIRS.has(`${i.trait}.${i.field}`)
    && i.value === '',
);

const key = (i: FieldInstance) => `${i.url}:${i.trait}.${i.field}`;

if (process.env.MODOKI_DUMP_AUTHORED_ASSET_REFS) {
  const byKey = new Map<string, FieldInstance[]>();
  for (const b of blanks) {
    const k = key(b);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(b);
  }
  console.log(JSON.stringify(
    [...byKey].map(([k, insts]) => ({ key: k, entities: insts.map((i) => i.entity) })),
    null,
    2,
  ));
}

describe('authored asset-ref fields must not be blank (#53)', () => {
  it.skipIf(!hasGames)('finds scene/prefab sources to scan (sanity: the guard is actually looking)', () => {
    expect(sceneLike.length).toBeGreaterThan(0);
    expect(allInstances.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasGames)('no NEW blank in a proven asset-ref field', () => {
    const baselineKeys = new Set(BASELINE.map((b) => b.key));
    const offenders = blanks
      .filter((b) => !baselineKeys.has(key(b)))
      .map((b) => `${key(b)} → entity "${b.entity}"`);
    expect(
      offenders,
      'This field has held a real asset GUID somewhere else in the repo, which proves it is an '
        + "asset-ref field — and here it's blank. An unset ref like this is invisible to every OTHER "
        + 'test in the repo (it is neither dangling nor a literal path) and surfaces only in a real '
        + 'production build or on device, per #53\'s close-out comment. If this blank is intentional '
        + '(an optional override slot, a field with a code fallback), add it to BASELINE with a '
        + 'reason. Otherwise author the ref in the scene/prefab.',
    ).toEqual([]);
  });

  it.skipIf(!hasGames)('every BASELINE entry still fires (no stale exemptions)', () => {
    const firing = new Set(blanks.map(key));
    const stale = BASELINE.filter((b) => !firing.has(b.key)).map((b) => b.key);
    expect(
      stale,
      'These entries are baselined as pre-existing blank asset refs but no longer fire — either '
        + 'the field was authored (good: delete the entry) or the file/trait/field moved. A baseline '
        + 'that outlives its entries stops being able to tell you what is left, and silently '
        + 're-permits the blank if it comes back.',
    ).toEqual([]);
  });
});
