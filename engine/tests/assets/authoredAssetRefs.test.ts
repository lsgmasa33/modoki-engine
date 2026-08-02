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
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { findAssetRoots, readAssetGuid, detectType, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { hasRealProjects } from '../helpers/repoLayout';

// engine/tests/assets/ → repo root (games/ + demos/ live there).
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
// The public engine snapshot ships neither games/ nor demos/ — nothing to audit there.
const hasGames = hasRealProjects();
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
  { key: '/games/3d-test/assets/scenes/2D Animation.scene.json:Renderable2D.material', why: '2D sprite falls back to the built-in default 2D material unless a custom one is authored' },
  { key: '/games/3d-test/assets/scenes/2D Animation.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/3d-test/assets/scenes/skinned-test.scene.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/3d-test/assets/scenes/skinned-test.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/3d-test/assets/scenes/tropical-island.scene.json:Renderable2D.material', why: '2D sprite falls back to the built-in default 2D material unless a custom one is authored' },
  { key: '/games/alien-animal/assets/models/alien-animal.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/anim-bug/assets/scenes/main.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/audio-demo/assets/scenes/main.scene.json:AudioSource.clip', why: 'clip is resolved per-cue from SFXBank/Music elsewhere, not a single fixed clip on this trait' },
  { key: '/games/codex/assets/scenes/main.scene.json:Renderable2D.material', why: '2D sprite falls back to the built-in default 2D material unless a custom one is authored' },
  { key: '/games/skin-test/assets/scenes/billboard-2_5d.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/bumper.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/bumper.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/cover-enemy.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/cover-enemy.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/enemy.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/enemy.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/goal-point.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/green-enemy.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/prefabs/green-enemy.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/puck.prefab.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/games/sling/assets/prefabs/puck.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/scenes/Lvl-0001.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/scenes/Lvl-0002.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/sling/assets/scenes/camera-demo.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/space-invader/assets/scenes/main.scene.json:AudioSource.clip', why: 'clip is resolved per-cue from SFXBank/Music elsewhere, not a single fixed clip on this trait' },
  { key: '/games/timeline-demo/assets/models/alien-animal.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/timeline-demo/assets/prefabs/spark.prefab.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/timeline-demo/assets/scenes/main.scene.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/timeline-demo/assets/scenes/main.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/games/timeline-demo/assets/scenes/nested.scene.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/games/timeline-demo/assets/scenes/overlap.scene.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/demos/3d-physics-demo/assets/scenes/physics-showcase.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/demos/3d-physics-demo/assets/scenes/physics-showcase.scene.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/demos/3d-physics-demo/assets/scenes/terrain-demo.scene.json:Renderable3D.material', why: 'blank observed on a single instance (Terrain) — needs an owner call whether that is intentional; kept in the baseline as pre-existing, not approved' },
  { key: '/demos/3d-physics-demo/assets/scenes/terrain-demo.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
  { key: '/demos/3d-physics-demo/assets/scenes/terrain-demo.scene.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/demos/forest-camp/assets/models/char_Ranger.prefab.json:SkeletalAnimator.animSet', why: 'optional per-instance animset override — blank means "use the rig/prefab default," not a missing ref' },
  { key: '/demos/forest-camp/assets/scenes/main.scene.json:Collider3D.mesh', why: 'primitive-shaped collider (box/sphere/capsule/etc.) — shape comes from primitive params, mesh is only used for a mesh-collider variant' },
  { key: '/demos/particle-demo/assets/scenes/main.scene.json:Renderable3DPrimitive.material', why: 'primitive-shape render — blank means "use the flat primitive color," not a forgotten material asset' },
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

/** Every instance of a proven asset-ref pair whose value is a blank string. */
const blanks = allInstances.filter((i) => provenPairs.has(`${i.trait}.${i.field}`) && i.value === '');

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
