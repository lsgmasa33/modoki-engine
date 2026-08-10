/** `checkMigration` — the guard that decides whether a legacy-scene save was LOSSLESS.
 *
 *  `engine/scripts/migrate-legacy-scenes.mjs` migrates a v9/v10 scene by driving the real editor
 *  (load-scene → save-all), because the serializer is the only source of truth for its own output.
 *  That is also the risk: a scene that loads with warnings — a missing GLB, a trait the editor's
 *  schema lacks — can serialize back lossily while the save reports `ok:true`. This guard is what
 *  makes the migration reviewable instead of a rewrite taken on trust, so it needs its own test:
 *  a guard nobody has watched fail is not known to work.
 *
 *  Every case below is a REAL verdict recorded while running the migration on `games/3d-test`
 *  (2026-07-30), not an invented one:
 *   - the editor's own output for `tropical-island.json` is accepted;
 *   - the hand-rolled text transform that preceded the script is REJECTED, because it left
 *     `PrefabInstance.rootInstanceId` numeric and would have dangled the prefab reference;
 *   - `ui-focus-demo.json` is REJECTED — the save inserted a `Time (resource)` entity (9 → 10);
 *   - default-materialization is REJECTED, which is why 5 of 7 scenes failed and the bulk migration
 *     was on hold (see docs/scene-loading.md).
 */

import { describe, it, expect } from 'vitest';
import { checkMigration } from '../../scripts/migrate-legacy-scenes.mjs';

const GUID_A = '43d67a90-3750-4b5f-888e-b91f39e76ae2';

/** A minimal legacy scene: two entities, the second a prefab instance rooted at the first. */
const legacy = () => ({
  id: 'scene-guid',
  version: 9,
  createdAt: '2026-01-01T00:00:00.000Z',
  entities: [
    { id: 22, name: 'Root', traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Root', guid: GUID_A, parentId: '' } } },
    { id: 23, name: 'Inst', traits: { PrefabInstance: { rootInstanceId: 22 }, EntityAttributes: { name: 'Inst', guid: 'b'.repeat(8) + '-0000-4000-8000-000000000000', parentId: '' } } },
  ],
});

/** What the real serializer produces: version bumped, ids gone, rootInstanceId now a GUID. */
const migrated = () => ({
  id: 'scene-guid',
  version: 12,
  createdAt: '2026-01-01T00:00:00.000Z',
  entities: [
    { name: 'Root', traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Root', guid: GUID_A, parentId: '' } } },
    { name: 'Inst', traits: { PrefabInstance: { rootInstanceId: GUID_A }, EntityAttributes: { name: 'Inst', guid: 'b'.repeat(8) + '-0000-4000-8000-000000000000', parentId: '' } } },
  ],
});

describe('checkMigration', () => {
  it('accepts real serializer output — version bump, ids dropped, entity ref guid-ified', () => {
    expect(checkMigration(legacy(), migrated())).toEqual([]);
  });

  it('REJECTS a half-migrated file that left rootInstanceId numeric', () => {
    // The hand-rolled text transform's actual failure: byte-identical to the editor's output
    // everywhere EXCEPT this, and stripping the numeric ids without converting it dangles the
    // prefab reference. This is why the script drives the editor instead of rewriting text.
    const half = migrated();
    // `!`: TS's array-literal union inference makes each entity's OTHER-branch fields
    // `?: undefined` companions (so PrefabInstance reads as possibly-undefined on the union) —
    // this is entity[1] ("Inst"), which the fixture above always gives a PrefabInstance.
    half.entities[1].traits.PrefabInstance!.rootInstanceId = 22 as never;
    expect(checkMigration(legacy(), half).join('\n')).toMatch(/rootInstanceId is still numeric \(22\)/);
  });

  it('REJECTS a lossy save that dropped an entity', () => {
    const lossy = migrated();
    lossy.entities.pop();
    expect(checkMigration(legacy(), lossy).join('\n')).toMatch(/ENTITY COUNT 2 -> 1 \(lossy save\)/);
  });

  it('REJECTS a save that ADDED an entity (the Time (resource) insertion)', () => {
    // Measured on ui-focus-demo.json against a freshly launched editor: 9 entities became 10.
    const grown = migrated();
    grown.entities.push({ name: 'Time (resource)', traits: { Time: {} } } as never);
    expect(checkMigration(legacy(), grown).join('\n')).toMatch(/ENTITY COUNT 2 -> 3/);
  });

  it('REJECTS default-materialization — a trait field that appeared out of nowhere', () => {
    // 5 of 7 scenes failed this way. Accepting it would bake TODAY's defaults into the file, so a
    // later change to a trait default would silently stop reaching that scene.
    const filled = migrated();
    (filled.entities[0].traits.Transform as Record<string, unknown>).shadowBias = -0.0003;
    expect(checkMigration(legacy(), filled).join('\n')).toMatch(/shadowBias: ADDED/);
  });

  it('REJECTS a changed value', () => {
    const changed = migrated();
    // `!`: see the note in the "numeric rootInstanceId" test above — entity[0] ("Root")
    // always carries a Transform in this fixture.
    changed.entities[0].traits.Transform!.x = 999;
    expect(checkMigration(legacy(), changed).join('\n')).toMatch(/Transform\.x: 1 -> 999/);
  });

  it('REJECTS a file that was never version-bumped', () => {
    const stale = migrated();
    stale.version = 9;
    expect(checkMigration(legacy(), stale).join('\n')).toMatch(/version is 9, expected 12/);
  });

  it('accepts an entity ref that became "" — serialize writes that for an unset or dangling ref', () => {
    const unset = migrated();
    unset.entities[1].traits.PrefabInstance!.rootInstanceId = '';
    expect(checkMigration(legacy(), unset)).toEqual([]);
  });

  it('ACCEPTS any GUID for a converted ref — and that looseness is deliberate', () => {
    // This test originally demanded the stronger rule ("the new GUID must be the guid of the entity
    // that held that id"), and the stronger rule was implemented. The REAL editor output then
    // failed it: in tropical-island.json, `rootInstanceId: 22` becomes `43d67a90-…` while the
    // entity with id 22 has NO guid in the legacy file and that GUID appears nowhere in either
    // version — because `rootInstanceId` identifies the prefab INSTANCE, not an entity, and the
    // serializer MINTS it on save. There is nothing to check it against, so int → GUID is the
    // strongest honest rule. Pinned as a test so nobody re-tightens it from first principles.
    const minted = migrated();
    minted.entities[1].traits.PrefabInstance!.rootInstanceId = 'ffffffff-0000-4000-8000-000000000000';
    expect(checkMigration(legacy(), minted)).toEqual([]);
  });

  it('REJECTS a changed top-level field (the scene GUID or createdAt)', () => {
    const reid = migrated();
    reid.id = 'different-guid';
    expect(checkMigration(legacy(), reid).join('\n')).toMatch(/top-level id changed/);
  });
});
