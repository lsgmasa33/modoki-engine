/**
 * An atlas edit must not delete the parts of the file this view does not render.
 *
 * `AtlasAssetView` renders members / pageSize / padding / extrude / maxPages and used to write
 * ONLY those, so every other top-level key was silently dropped on the first edit. Measured on
 * `games/skin-test`'s `dark-assassin.atlas.json` (bug `EDnpmBkOOLbeqgDCaQC1`, QA-ASSET-0013): an
 * add-then-remove round-trip left `members[]` byte-identical and still deleted the whole
 * `texture` block — the format/wrap/colorspace settings that decide how the packed page is
 * encoded. This is the generic version of the trap CLAUDE.md records for prefabs: a
 * hand-maintained list of "fields we read" goes stale invisibly.
 *
 * ⚠️ This tested `serializeAtlasDoc`, which returned BYTES; since #831 the panel PARKS an object
 * and the bytes are the server's, so it tests `buildAtlasDocToPark` instead. The one assertion
 * that did not survive the move is "ends with a newline": that is now `assetJsonBytes`' single
 * definition of a JSON document's bytes, pinned in `engine/tests/plugins/assetJsonBytesAgree.test.ts`
 * against the writer AND both self-write fingerprints. It was moved, not dropped — a client-side
 * copy of that format is exactly what drifted last time.
 */
import { describe, it, expect } from 'vitest';
import { buildAtlasDocToPark } from '../../src/editor/panels/assetViews/AtlasAssetView';

/** The shape of the real fixture, abbreviated. */
const onDisk = {
  id: '6745abbf-d4a3-40f4-a74d-a0ea526cef8e',
  version: 1,
  members: ['sprite-a', 'sprite-b'],
  texture: { format: 'ktx2-uastc', maxSize: 2048, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' },
  pageSize: 2048,
  padding: 2,
  extrude: 1,
};

// No `version` key here (#784, docs/format-versioning.md § 2b) — this fixture models what
// `AtlasAssetView.update()`'s `next` now builds (`{ ...prev, ...patch }`, no version literal).
// It used to carry `version: 1 as const`, which — spread AFTER `raw` in the merge below —
// clobbered whatever version the file actually had on every single edit; see the version-2 test
// below for the direct regression coverage.
const edited = { id: onDisk.id, members: ['sprite-a', 'sprite-b'], pageSize: 2048, padding: 2, extrude: 1 };

describe('buildAtlasDocToPark', () => {
  it('carries the top-level texture block through an edit', () => {
    const out = (buildAtlasDocToPark(onDisk, edited));
    expect(out.texture).toEqual(onDisk.texture);
  });

  it('carries through a field nobody has invented yet', () => {
    // The point is not `texture` specifically — it is that this view must stop deciding which
    // fields deserve to survive. A future key must round-trip with no code change here.
    const out = (buildAtlasDocToPark({ ...onDisk, someFutureKey: { a: 1 } }, edited));
    expect(out.someFutureKey).toEqual({ a: 1 });
  });

  it('still applies the edit — passthrough must not shadow a changed field', () => {
    const out = (buildAtlasDocToPark(onDisk, { ...edited, members: ['sprite-a'], padding: 7 }));
    expect(out.members).toEqual(['sprite-a']);
    expect(out.padding).toBe(7);
  });

  it('preserves key ORDER, so an edit is a minimal diff and not a reshuffle', () => {
    // Still asserted HERE even though this no longer produces bytes: `JSON.stringify` walks
    // insertion order, so the order of the object this builds IS the order of the written file.
    expect(Object.keys(buildAtlasDocToPark(onDisk, edited))).toEqual(['id', 'version', 'members', 'texture', 'pageSize', 'padding', 'extrude']);
  });

  it('omits an unset maxPages instead of writing null', () => {
    // The Max-pages field clears itself with `maxPages: undefined`. Spreading that over a raw doc
    // that HAS the key would otherwise leave an explicit undefined that JSON.stringify keeps as
    // absent only by luck of key order.
    // `hasOwnProperty`, not `=== undefined`: `/api/asset-write`'s dropped-field guard reads
    // `Object.keys`, so a key left in place with an undefined value would read as PRESENT there
    // and as absent in the JSON — the two disagreeing is the whole reason this deletes the key.
    const out = buildAtlasDocToPark({ ...onDisk, maxPages: 4 }, { ...edited, maxPages: undefined });
    expect(Object.keys(out)).not.toContain('maxPages');
  });

  it('writes a clean document when the file had nothing extra', () => {
    expect((buildAtlasDocToPark({}, edited))).toEqual(edited);
  });

  // #423/#430-adjacent: confirm losing the atlas's own `id` GUID is impossible through this
  // path specifically (not just "the texture block survives") — `next` already carries the raw
  // doc's `id` (the load effect always seeds `doc.id` from what it read), so this is the
  // ordinary edit round-trip, not a passthrough-only case like the `texture` block above.
  it('the id GUID survives an edit round-trip', () => {
    const out = (buildAtlasDocToPark(onDisk, { ...edited, id: onDisk.id, padding: 9 }));
    expect(out.id).toBe(onDisk.id);
  });

  // Direct regression test for 2b (#784): `next` used to carry a hardcoded `version: 1 as const`
  // that overwrote `raw`'s version on every edit — invisible as long as `raw.version` also read
  // `1`, which is why it went unnoticed. A document written by a build newer than this one
  // (`version: 2`) must survive an `update()` round trip unchanged.
  it('a NEWER version than this build writes (2) survives an update() round trip', () => {
    const onDiskV2 = { ...onDisk, version: 2 };
    const out = (buildAtlasDocToPark(onDiskV2, { ...edited, padding: 9 }));
    expect(out.version).toBe(2);
    expect(out.padding).toBe(9); // the edit itself still applies
  });
});
