/**
 * A scene's top-level `resources` array is REGENERATED on every save, and that regeneration
 * is DETERMINISTIC.
 *
 * Issue #17 observed the array growing on a no-op save of `material-instance-demo.json` (2 → 3+
 * entries) and posed the fork this file settles: is the ref walk simply **more complete** than
 * whatever an older save wrote (in which case a byte-identity checker should accept the new,
 * larger array), or is it **unstable run-to-run** (in which case it is churn worth fixing)?
 *
 * It is the first. `serializeScene` does not preserve the array it loaded — it discards it and
 * rebuilds from the entities (`const resources = collectResourceRefs(entities)`), which is
 * consistent with `resources` being documented as *a hint, not the authority* (SceneManager
 * re-walks the entities at load anyway). So a file carrying a thin array — written by an older,
 * less complete walk — is upgraded exactly once, and is stable from then on.
 *
 * That makes the practical rule for anything comparing a scene before/after a save: **normalize
 * by saving once, or compare `resources` as a set, not as a byte range.** Not "fix the churn",
 * because the second save produces the same bytes as the first.
 *
 * Tested at the collector rather than through a full load→save round-trip on purpose: the
 * property in doubt belongs to the pure walk, and pinning it here needs no world, no mocked
 * `fetch`, and no trait-registry double — so it cannot rot for reasons unrelated to the claim.
 * The round-trip half is already covered by the A10 gates (`scenePathIndependence`,
 * `sceneCreatedAtStability`, `sceneIdStability`).
 */

import { describe, it, expect } from 'vitest';
import { collectResourceRefsFromEntities } from '../../src/runtime/loaders/loadSceneFile';

const MESH = 'aaaaaaaa-0000-4000-8000-000000000001';
const MAT = 'bbbbbbbb-0000-4000-8000-000000000002';
const TEX = 'cccccccc-0000-4000-8000-000000000003';
const AUDIO = 'dddddddd-0000-4000-8000-000000000004';

/** Two entities between them referencing a mesh, a material, a sprite texture and an audio clip
 *  — four distinct scalar ref fields drawn from SCALAR_RESOURCE_TYPE_BY_FIELD. */
const entities = () => [
  { traits: { Renderable3D: { mesh: MESH, material: MAT } } },
  { traits: { Renderable2D: { sprite: TEX }, AudioSource: { clip: AUDIO } } },
];

describe('collectResourceRefsFromEntities — the #17 resources question', () => {
  it('is DETERMINISTIC: the same entities produce the identical array, order included', () => {
    const a = collectResourceRefsFromEntities(entities());
    const b = collectResourceRefsFromEntities(entities());
    // Deep-equal, not set-equal: order is part of the claim, since an unstable ORDER would
    // churn a file's bytes just as surely as an unstable membership would.
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('finds every scalar ref, so a thin committed array is a SUBSET of a fresh walk', () => {
    const fresh = collectResourceRefsFromEntities(entities());
    const paths = fresh.map((r) => r.path);
    expect(paths).toContain(MESH);
    expect(paths).toContain(MAT);
    expect(paths).toContain(TEX);
    expect(paths).toContain(AUDIO);
    // The concrete #17 shape: a file that recorded only 2 of these (an older, thinner walk)
    // is not in conflict with the new array — it is contained by it. That is what makes
    // "accept a superset" the correct reading rather than "stop the churn".
    const stale = [{ type: 'mesh', path: MESH }, { type: 'material', path: MAT }];
    for (const s of stale) expect(fresh).toEqual(expect.arrayContaining([expect.objectContaining({ path: s.path })]));
    expect(fresh.length).toBeGreaterThan(stale.length);
  });

  it('DEDUPES a ref two entities share, so the array cannot grow with entity count', () => {
    const shared = collectResourceRefsFromEntities([
      { traits: { Renderable3D: { mesh: MESH, material: MAT } } },
      { traits: { Renderable3D: { mesh: MESH, material: MAT } } },
    ]);
    expect(shared.filter((r) => r.path === MESH)).toHaveLength(1);
    expect(shared.filter((r) => r.path === MAT)).toHaveLength(1);
  });

  // Mutation-checked, and the result is worth recording: this property is guarded TWICE —
  // `looksFetchable` rejects `''`/undefined before `add` is reached, and `add`'s own `!ref`
  // rejects it again. Breaking either guard alone leaves the test green; only breaking BOTH
  // fails it. So do not read a single-mutation "still passes" here as a vacuous test — it is
  // defence in depth. (It also means either guard could be deleted as dead code without a
  // failure, which is the flip side worth knowing.)
  it('ignores an empty/absent ref rather than emitting a blank entry', () => {
    const refs = collectResourceRefsFromEntities([
      { traits: { Renderable3D: { mesh: '', material: undefined } } },
      { traits: {} },
    ]);
    expect(refs).toEqual([]);
  });
});
