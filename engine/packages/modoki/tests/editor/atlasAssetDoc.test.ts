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
 */
import { describe, it, expect } from 'vitest';
import { serializeAtlasDoc } from '../../src/editor/panels/assetViews/AtlasAssetView';

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

const edited = { id: onDisk.id, version: 1, members: ['sprite-a', 'sprite-b'], pageSize: 2048, padding: 2, extrude: 1 };

describe('serializeAtlasDoc', () => {
  it('carries the top-level texture block through an edit', () => {
    const out = JSON.parse(serializeAtlasDoc(onDisk, edited));
    expect(out.texture).toEqual(onDisk.texture);
  });

  it('carries through a field nobody has invented yet', () => {
    // The point is not `texture` specifically — it is that this view must stop deciding which
    // fields deserve to survive. A future key must round-trip with no code change here.
    const out = JSON.parse(serializeAtlasDoc({ ...onDisk, someFutureKey: { a: 1 } }, edited));
    expect(out.someFutureKey).toEqual({ a: 1 });
  });

  it('still applies the edit — passthrough must not shadow a changed field', () => {
    const out = JSON.parse(serializeAtlasDoc(onDisk, { ...edited, members: ['sprite-a'], padding: 7 }));
    expect(out.members).toEqual(['sprite-a']);
    expect(out.padding).toBe(7);
  });

  it('preserves key ORDER, so an edit is a minimal diff and not a reshuffle', () => {
    const out = serializeAtlasDoc(onDisk, edited);
    expect(Object.keys(JSON.parse(out))).toEqual(['id', 'version', 'members', 'texture', 'pageSize', 'padding', 'extrude']);
  });

  it('ends with a newline', () => {
    // The other half of the reported diff: the committed file has one and the write dropped it.
    expect(serializeAtlasDoc(onDisk, edited).endsWith('}\n')).toBe(true);
  });

  it('omits an unset maxPages instead of writing null', () => {
    // The Max-pages field clears itself with `maxPages: undefined`. Spreading that over a raw doc
    // that HAS the key would otherwise leave an explicit undefined that JSON.stringify keeps as
    // absent only by luck of key order.
    const out = serializeAtlasDoc({ ...onDisk, maxPages: 4 }, { ...edited, maxPages: undefined });
    expect(JSON.parse(out)).not.toHaveProperty('maxPages');
    expect(out).not.toContain('null');
  });

  it('writes a clean document when the file had nothing extra', () => {
    expect(JSON.parse(serializeAtlasDoc({}, edited))).toEqual(edited);
  });

  // #423/#430-adjacent: confirm losing the atlas's own `id` GUID is impossible through this
  // path specifically (not just "the texture block survives") — `next` already carries the raw
  // doc's `id` (the load effect always seeds `doc.id` from what it read), so this is the
  // ordinary edit round-trip, not a passthrough-only case like the `texture` block above.
  it('the id GUID survives an edit round-trip', () => {
    const out = JSON.parse(serializeAtlasDoc(onDisk, { ...edited, id: onDisk.id, padding: 9 }));
    expect(out.id).toBe(onDisk.id);
  });
});
