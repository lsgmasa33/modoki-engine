/** `.rig2d.json` has never had a format-version field — `Rig2DFile` doesn't declare one,
 *  `defaultRig2DFile()` doesn't emit one, and no code reads or writes one. What actually
 *  selects v1 vs v2 is the SHAPE (`parts[]` present or not), not a stamped number. The
 *  `RIG2D_FIELDS` schema row that advertised a `version` field was therefore an unread
 *  authoring surface — an Inspector field that does nothing when edited — and was removed
 *  in #784 phase C1.
 *
 *  This guard fails if either comes back: a `version` key re-added to `RIG2D_FIELDS`, or
 *  `defaultRig2DFile()` starting to stamp one. */
import { describe, it, expect } from 'vitest';
import { getAssetSchema } from '../../packages/modoki/src/runtime/assets/assetSchemas';
import { defaultRig2DFile } from '../../packages/modoki/src/runtime/skinning/rig2dTypes';

describe('.rig2d.json advertises no format version (#784)', () => {
  it('the rig2d schema fields carry no "version" key', () => {
    const schema = getAssetSchema('rig2d');
    expect(schema, 'rig2d schema not found — did the type name change?').toBeTruthy();
    const keys = schema!.fields.map((f) => f.key);
    // Anchor: the schema must still be non-trivial (a stripped-down field list would let
    // this pass vacuously) — `bones` is the one field every rig2d shape carries.
    expect(keys).toContain('bones');
    expect(keys).not.toContain('version');
  });

  it('defaultRig2DFile() emits no "version" key', () => {
    const file = defaultRig2DFile();
    expect('version' in file).toBe(false);
  });
});
