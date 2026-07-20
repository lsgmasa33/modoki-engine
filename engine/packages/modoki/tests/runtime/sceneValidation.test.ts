/** sceneValidation unit tests — structural checks, trait/field type checks, and
 *  the GUID asset-reference rule. Pure module, no world needed. */

import { describe, it, expect } from 'vitest';
import { validateSceneData, type SceneSchema } from '../../src/runtime/scene/sceneValidation';

const GUID = 'a1b2c3d4-1111-2222-3333-444455556666';

const schema: SceneSchema = {
  traits: {
    Transform: {
      category: 'component',
      fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
    },
    Renderable3D: {
      category: 'component',
      fields: { mesh: { type: 'string' }, material: { type: 'string' }, castShadow: { type: 'boolean' } },
    },
    EntityAttributes: {
      category: 'component',
      fields: { name: { type: 'string' }, guid: { type: 'string' }, layer: { type: 'enum', options: ['2d', '3d', 'ui'] }, parentId: { type: 'number' } },
    },
    UIElement: {
      category: 'component',
      fields: { imageSrc: { type: 'string' } },
    },
    UIAction: {
      category: 'component',
      fields: { bindings: { type: 'bindings' } },
    },
    MaterialInstance: {
      category: 'component',
      fields: { overrides: { type: 'materialOverrides' } },
    },
    Persistent: { category: 'tag', fields: {} },
  },
};

const ua = (bindings: unknown) => scene([{ id: 1, name: 'Btn', traits: { UIAction: { bindings } } }]);

const scene = (entities: unknown[]) => ({ version: 8, entities });

describe('validateSceneData — structural', () => {
  it('flags a non-object scene', () => {
    expect(validateSceneData(null).warnings[0]).toMatch(/not an object/);
  });

  it('flags missing entities array', () => {
    expect(validateSceneData({ version: 8 }).warnings[0]).toMatch(/entities is missing/);
  });

  it('passes a clean scene', () => {
    const res = validateSceneData(
      scene([{ id: 1, name: 'Cube', traits: { Transform: { x: 0, y: 0, z: 0 } } }]),
      schema,
    );
    expect(res.warnings).toEqual([]);
    expect(res.schemaApplied).toBe(true);
  });

  it('flags a trait value that is neither object nor boolean', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Transform: 5 } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/must be an object or boolean/);
  });
});

describe('validateSceneData — referential integrity (F4)', () => {
  it('flags duplicate entity ids', () => {
    const res = validateSceneData(scene([
      { id: 1, name: 'A', traits: {} },
      { id: 1, name: 'B', traits: {} },
    ]));
    expect(res.warnings.join('\n')).toMatch(/duplicate entity id #1/);
  });

  it('flags a parentId (guid) that resolves to no entity', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'Orphan', traits: { EntityAttributes: { parentId: GUID } } }]));
    expect(res.warnings.join('\n')).toMatch(/parentId '.*' references no entity/);
  });

  it('flags a parentId (legacy numeric) that resolves to no entity', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'Orphan', traits: { EntityAttributes: { parentId: 99 } } }]));
    expect(res.warnings.join('\n')).toMatch(/parentId #99 references no entity/);
  });

  it('flags a self-referencing parentId', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'Self', traits: { EntityAttributes: { guid: GUID, parentId: GUID } } }]));
    expect(res.warnings.join('\n')).toMatch(/parentId references itself/);
  });

  it('flags a UIAction.target that resolves to no entity', () => {
    const res = validateSceneData(scene([
      { id: 1, name: 'Btn', traits: { UIAction: { bindings: [{ event: 'click', kind: 'set', target: GUID }] } } },
    ]));
    expect(res.warnings.join('\n')).toMatch(/UIAction\.target '.*' references no entity/);
  });

  it('flags a PrefabInstance.source self-reference', () => {
    const res = validateSceneData(scene([
      { id: 1, name: 'P', traits: { EntityAttributes: { guid: GUID }, PrefabInstance: { source: GUID } } },
    ]));
    expect(res.warnings.join('\n')).toMatch(/PrefabInstance\.source references its own entity/);
  });

  it('stays clean when parent + targets all resolve', () => {
    const res = validateSceneData(scene([
      { id: 1, name: 'Panel', traits: { EntityAttributes: { guid: GUID } } },
      { id: 2, name: 'Child', traits: { EntityAttributes: { parentId: GUID } } },
      { id: 3, name: 'Btn', traits: { UIAction: { bindings: [{ event: 'click', kind: 'set', target: GUID }] } } },
    ]));
    expect(res.warnings).toEqual([]);
  });
});

describe('validateSceneData — schema checks', () => {
  it('flags unknown trait', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Wobble: {} } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/unknown trait 'Wobble'/);
  });

  it('flags unknown field', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Transform: { x: 0, q: 1 } } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/unknown field 'q'/);
  });

  it('flags type mismatch (string where number expected)', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Transform: { x: '0' } } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/expected number, got string/);
  });

  it('flags enum value not in options', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { EntityAttributes: { layer: 'nope' } } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/not in \[2d, 3d, ui\]/);
  });

  it('accepts EntityAttributes.parentId as a GUID string (serialized form), a number (legacy), or empty', () => {
    // Parents are present so the type-acceptance is tested without tripping the
    // referential-integrity (dangling-parent) check.
    const guidParent = validateSceneData(scene([
      { id: 1, name: 'X', traits: { EntityAttributes: { parentId: GUID } } },
      { id: 2, name: 'P', traits: { EntityAttributes: { guid: GUID } } },
    ]), schema);
    expect(guidParent.warnings.join('\n')).not.toMatch(/parentId/);
    const rootParent = validateSceneData(scene([{ id: 1, name: 'X', traits: { EntityAttributes: { parentId: '' } } }]), schema);
    expect(rootParent.warnings.join('\n')).not.toMatch(/parentId/);
    const legacyParent = validateSceneData(scene([
      { id: 1, name: 'X', traits: { EntityAttributes: { parentId: 3 } } },
      { id: 3, name: 'P', traits: { EntityAttributes: {} } },
    ]), schema);
    expect(legacyParent.warnings.join('\n')).not.toMatch(/parentId/);
  });

  it('treats a typeless field as known and skips type-checking it', () => {
    const s: SceneSchema = { traits: { Weird: { category: 'component', fields: { data: {} } } } };
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Weird: { data: [1, 2, 3] } } }]), s);
    expect(res.warnings).toEqual([]); // known field, array value not flagged
  });

  it('passes well-formed UIAction bindings (set + call)', () => {
    // Include the target entity so the binding resolves (no dangling-ref warning).
    const res = validateSceneData(scene([
      { id: 1, name: 'Btn', traits: { UIAction: { bindings: [
        { event: 'click', kind: 'set', target: GUID, component: 'UIElement', property: 'isVisible', value: true },
        { event: 'change', kind: 'call', action: 'engine.loadScene' },
      ] } } },
      { id: 2, name: 'Panel', traits: { EntityAttributes: { guid: GUID } } },
    ]), schema);
    expect(res.warnings).toEqual([]);
  });

  it('flags bindings that are not an array', () => {
    expect(validateSceneData(ua({}), schema).warnings.join('\n')).toMatch(/expected binding array/);
  });

  it('flags a set binding missing component/property', () => {
    const res = validateSceneData(ua([{ event: 'click', kind: 'set', target: GUID }]), schema);
    expect(res.warnings.join('\n')).toMatch(/binding\[0\]\.component must be a string/);
  });

  it('flags a call binding missing an action name', () => {
    const res = validateSceneData(ua([{ event: 'click', kind: 'call' }]), schema);
    expect(res.warnings.join('\n')).toMatch(/binding\[0\]\.action must be a string/);
  });

  it('flags a binding with a non-string kind', () => {
    const res = validateSceneData(ua([{ event: 'click', kind: 7 }]), schema);
    expect(res.warnings.join('\n')).toMatch(/binding\[0\]\.kind must be/);
  });

  it('flags a binding with an unknown kind (stale/typo)', () => {
    // The migration safety-net must catch a stale kind like 'toggle' that is a
    // string but not one of the two valid kinds — runtime treats it as inert.
    const res = validateSceneData(ua([{ event: 'click', kind: 'toggle', action: 'x' }]), schema);
    expect(res.warnings.join('\n')).toMatch(/binding\[0\]\.kind must be 'set' or 'call'/);
  });

  it('flags a binding with an unknown event', () => {
    const res = validateSceneData(ua([{ event: 'hover', kind: 'call', action: 'x' }]), schema);
    expect(res.warnings.join('\n')).toMatch(/binding\[0\]\.event "hover" is not one of/);
  });

  it('skips field type checks without a schema, but still runs ref checks', () => {
    const res = validateSceneData(
      scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: '/games/x/foo.mesh.json' } } }]),
    );
    expect(res.schemaApplied).toBe(false);
    expect(res.warnings.join('\n')).toMatch(/internal asset path/);
  });

  const mi = (overrides: unknown) => scene([{ id: 1, name: 'M', traits: { MaterialInstance: { overrides } } }]);

  it('passes well-formed material overrides (constant / time / store / curve)', () => {
    const res = validateSceneData(mi([
      { target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } },
      { target: 'stripeTime', kind: 'uniform', source: { type: 'time', wrap: 1 } },
      { target: 'glow', kind: 'uniform', source: { type: 'store', key: 'hp', scale: 0.1 } },
      { target: 'r', kind: 'uniform', source: { type: 'curve', points: [{ t: 0, v: 0 }, { t: 1, v: 1 }], driver: { type: 'time', wrap: 1 } } },
    ]), schema);
    expect(res.warnings).toEqual([]);
  });

  it('allows an empty target (a freshly-added, unconfigured override)', () => {
    const res = validateSceneData(mi([{ target: '', kind: 'uniform', source: { type: 'constant', value: 0 } }]), schema);
    expect(res.warnings).toEqual([]);
  });

  it('flags an override source with an unknown type', () => {
    const res = validateSceneData(mi([{ target: 'x', kind: 'uniform', source: { type: 'bogus' } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/source\.type "string" is not one of/);
  });

  it('flags a curve source missing its points array or driver', () => {
    const noPoints = validateSceneData(mi([{ target: 'x', source: { type: 'curve', driver: { type: 'time' } } }]), schema);
    expect(noPoints.warnings.join('\n')).toMatch(/curve\) must have a points array/);
    const noDriver = validateSceneData(mi([{ target: 'x', source: { type: 'curve', points: [] } }]), schema);
    expect(noDriver.warnings.join('\n')).toMatch(/curve\) must have a driver/);
  });

  it('flags a curve whose driver is itself a curve', () => {
    const res = validateSceneData(mi([{ target: 'x', source: { type: 'curve', points: [], driver: { type: 'curve' } } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/driver\.type must be a non-curve source/);
  });

  // ── kind:'texture' — a 2D extra-sampler swap: has a `ref` GUID, NO `source`. ──
  it('passes a kind:texture override carrying a sprite/texture ref (no source)', () => {
    const res = validateSceneData(mi([{ target: 'uReveal', kind: 'texture', ref: GUID }]), schema);
    expect(res.warnings).toEqual([]);
  });

  it('passes a kind:texture override with no ref yet (freshly added, unconfigured)', () => {
    const res = validateSceneData(mi([{ target: 'uReveal', kind: 'texture' }]), schema);
    expect(res.warnings).toEqual([]);
  });

  it('flags a kind:texture override whose ref is not a string', () => {
    const res = validateSceneData(mi([{ target: 'uReveal', kind: 'texture', ref: 42 }]), schema);
    expect(res.warnings.join('\n')).toMatch(/ref must be a string \(a sprite\/texture GUID\)/);
  });

  it('skips the source checks for a kind:texture override even with a stale source present', () => {
    // A row switched TO texture may still carry a leftover (malformed) source; the
    // texture branch must `continue` past the source validation instead of flagging it.
    const res = validateSceneData(mi([{ target: 'uReveal', kind: 'texture', ref: GUID, source: { type: 'bogus' } }]), schema);
    expect(res.warnings).toEqual([]);
  });
});

describe('validateSceneData — asset reference rule', () => {
  it('accepts a GUID ref', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: GUID } } }]), schema);
    expect(res.warnings).toEqual([]);
  });

  it('accepts an external URL', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { UIElement: { imageSrc: 'https://x/y.png' } } }]), schema);
    expect(res.warnings).toEqual([]);
  });

  it('accepts primitive sprite keywords on Renderable2D', () => {
    const s: SceneSchema = { traits: { Renderable2D: { category: 'component', fields: { sprite: { type: 'string' } } } } };
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Renderable2D: { sprite: 'circle' } } }]), s);
    expect(res.warnings).toEqual([]);
  });

  it('flags an internal asset path in a ref field', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Renderable3D: { material: '/a/b.mat.json' } } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/internal asset path .* references must be a GUID/);
  });

  it('flags a non-GUID, non-URL ref', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Environment: { hdrPath: 'sky' } } }]), schema);
    expect(res.warnings.join('\n')).toMatch(/is not a GUID or URL/);
  });

  it('ignores empty-string refs', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: '' } } }]), schema);
    expect(res.warnings).toEqual([]);
  });

  // Renderable2D.material is a NEW ref field (REF_FIELDS_BY_TRAIT.Renderable2D = ['sprite','material']).
  // Unlike `sprite`, it gets NO primitive-keyword exemption — that carve-out is gated on field==='sprite'.
  describe('Renderable2D.material', () => {
    it('flags an internal asset path as needing a GUID', () => {
      const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Renderable2D: { material: '/a/b.shader.json' } } }]));
      expect(res.warnings.join('\n')).toMatch(/internal asset path .* references must be a GUID/);
    });

    it('does NOT exempt a primitive-sprite keyword (circle) on material', () => {
      const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Renderable2D: { material: 'circle' } } }]));
      expect(res.warnings.join('\n')).toMatch(/'circle' is not a GUID or URL/);
    });

    it('accepts a GUID material', () => {
      const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Renderable2D: { material: GUID } } }]));
      expect(res.warnings).toEqual([]);
    });
  });
});

describe('validateSceneData — materialOverrides shape', () => {
  // MaterialInstance.overrides is type-checked as a `materialOverrides` FieldType — its
  // malformed-shape branches surface precise messages so an agent editing JSON can self-correct.
  const mi = (overrides: unknown) => scene([{ id: 1, name: 'M', traits: { MaterialInstance: { overrides } } }]);

  it('flags overrides that are not an array', () => {
    expect(validateSceneData(mi({}), schema).warnings.join('\n')).toMatch(/expected override array/);
  });

  it('flags a null override element', () => {
    expect(validateSceneData(mi([null]), schema).warnings.join('\n')).toMatch(/override\[0\] must be an object/);
  });

  it('flags a non-string target', () => {
    expect(validateSceneData(mi([{ target: 7, source: { type: 'constant' } }]), schema).warnings.join('\n'))
      .toMatch(/override\[0\]\.target must be a string/);
  });

  it("flags a kind that is not 'uniform', 'prop', or 'texture'", () => {
    expect(validateSceneData(mi([{ target: 'x', kind: 'attr', source: { type: 'constant' } }]), schema).warnings.join('\n'))
      .toMatch(/override\[0\]\.kind must be 'uniform', 'prop', or 'texture'/);
  });

  it('flags a missing / non-object source', () => {
    expect(validateSceneData(mi([{ target: 'x', kind: 'uniform' }]), schema).warnings.join('\n'))
      .toMatch(/override\[0\]\.source must be an object/);
  });
});
