/** buildSceneSchema unit tests — the field set must come from the koota schema
 *  (superset of Inspector hints), with Inspector hints overlaid for precise
 *  types/options, and non-primitive defaults left untyped. This guards the
 *  false-positive fix where schema fields absent from meta.fields were flagged
 *  as "unknown field". */

import { describe, it, expect } from 'vitest';
import { trait } from 'koota';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { buildSceneSchema } from '../../src/runtime/scene/sceneSchema';

describe('buildSceneSchema', () => {
  it('derives fields from the koota schema and overlays Inspector hints', () => {
    // koota requires a callback for non-primitive (object/array) defaults; its
    // .schema then stores the function — which inferType maps to "untyped".
    const T = trait({ x: 0, label: '', flag: false, tags: () => [] as string[] });
    registerTrait({
      name: 'SchemaTestTrait',
      trait: T,
      category: 'component',
      fields: {
        x: { type: 'number' },
        // Inspector adds a richer type + a field NOT in the koota schema.
        color: { type: 'color' },
        mode: { type: 'enum', options: ['a', 'b'] },
      },
    });

    const schema = buildSceneSchema();
    const fields = schema.traits['SchemaTestTrait'].fields;

    // koota-only field with primitive default → inferred type
    expect(fields.flag).toEqual({ type: 'boolean' });
    // koota-only field with non-primitive default (array) → known but untyped
    expect(fields.tags).toEqual({ type: undefined });
    // koota string field
    expect(fields.label).toEqual({ type: 'string' });
    // Inspector overlay wins for precise type
    expect(fields.x).toEqual({ type: 'number' });
    expect(fields.color).toEqual({ type: 'color' });
    expect(fields.mode).toEqual({ type: 'enum', options: ['a', 'b'] });
  });

  it('enumerates AoS trait fields (factory schema) so custom-section fields are KNOWN', () => {
    // An AoS trait (`trait(() => ({...}))`) stores its schema as a FACTORY, not an
    // object. Fields edited by a custom Inspector section (animSets/boneMaps here,
    // like AnimationLibrary) aren't in meta.fields — but must still be KNOWN to the
    // validator, or every scene using the trait false-flags "unknown field".
    const Lib = trait(() => ({ animSets: [] as string[], retarget: false, boneMaps: {} as Record<string, unknown> }));
    registerTrait({
      name: 'SchemaAoSTrait', trait: Lib, category: 'component',
      fields: { retarget: { type: 'boolean' } }, // only retarget; the rest are a custom section
    });

    const fields = buildSceneSchema().traits['SchemaAoSTrait'].fields;
    expect(fields.retarget).toEqual({ type: 'boolean' });
    expect(fields.animSets).toEqual({ type: undefined }); // known (array) but untyped → not "unknown field"
    expect(fields.boneMaps).toEqual({ type: undefined }); // known (object) but untyped
  });

  it('records the trait category', () => {
    const Tag = trait({});
    registerTrait({ name: 'SchemaTestTag', trait: Tag, category: 'tag', fields: {} });
    expect(buildSceneSchema().traits['SchemaTestTag'].category).toBe('tag');
  });
});
