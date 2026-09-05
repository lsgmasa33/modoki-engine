/** sceneValidation unit tests — structural checks, trait/field type checks, and
 *  the GUID asset-reference rule. Pure module, no world needed. */

import { describe, it, expect } from 'vitest';
import { validateSceneData, type SceneSchema, type PrefabResolver, type AssetRefResolver, type AssetRefVerdict, makeAssetRefResolver } from '../../src/runtime/loaders/sceneValidation';

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
    PrefabInstance: {
      category: 'component',
      fields: {
        source: { type: 'string' },
        localId: { type: 'number' },
        rootInstanceId: { type: 'number' },
        parentLocalId: { type: 'number' },
      },
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

  it('accepts PrefabInstance.rootInstanceId as a GUID string (serialized form, Phase 2, scene-loading.md) or a legacy number', () => {
    const guidForm = validateSceneData(scene([
      { id: 1, name: 'Root', guid: GUID, traits: { EntityAttributes: { parentId: '' }, PrefabInstance: { source: GUID, rootInstanceId: GUID } } },
    ]), schema);
    expect(guidForm.warnings.join('\n')).not.toMatch(/rootInstanceId/);
    const legacyForm = validateSceneData(scene([
      { id: 1, name: 'Root', traits: { PrefabInstance: { source: GUID, rootInstanceId: 1 } } },
    ]), schema);
    expect(legacyForm.warnings.join('\n')).not.toMatch(/rootInstanceId/);
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

/** The ONE implementation of the three-state rule, shared by the dev-server routes and the
 *  scene hot-reload handler. It exists because the rule was hand-written twice and the copies
 *  had already diverged on letter case inside the very commit that added them — the
 *  hot-reload copy lived in a private, untestable function, so only the wrong one was pinned.
 *  Tested here directly so the shared rule cannot drift again unnoticed. */
describe('makeAssetRefResolver', () => {
  const A = 'a1b2c3d4-1111-2222-3333-444455556666';
  const B = 'b1b2c3d4-1111-2222-3333-444455556666';

  it('answers ok for an exact-case guid', () => {
    expect(makeAssetRefResolver([A, B])!(A)).toBe('ok');
  });

  /** Case-SENSITIVE on purpose: `resolveRef` is `guidToEntry.get(ref)` over guids stored
   *  verbatim, so folding case would vouch for a ref that fails to load. */
  it('answers case-mismatch for a folded-case-only hit, never ok', () => {
    expect(makeAssetRefResolver([A])!(A.toUpperCase())).toBe('case-mismatch');
  });

  it('answers missing for a guid absent at any casing', () => {
    expect(makeAssetRefResolver([A])!(B)).toBe('missing');
  });

  /** The load-bearing guard: no guids means "could not check", so the caller must get
   *  NO resolver — not one that calls every ref in a healthy scene dead. */
  it('returns undefined when there is nothing to check against', () => {
    expect(makeAssetRefResolver([])).toBeUndefined();
    expect(makeAssetRefResolver([null, undefined, '', 7])).toBeUndefined();
  });

  /** A malformed manifest entry must not turn a validation that always answered into a
   *  failed call — skip the bad ones, keep indexing the good ones. */
  it('skips non-string / empty guids without throwing, and still indexes the rest', () => {
    const r = makeAssetRefResolver([null, A, 7, '', undefined, B]);
    expect(r).toBeDefined();
    expect(r!(A)).toBe('ok');
    expect(r!(B)).toBe('ok');
    expect(r!('c1b2c3d4-1111-2222-3333-444455556666')).toBe('missing');
  });

  it('is usable directly as the validator\'s resolver', () => {
    const res = validateSceneData(
      scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: B } } }]),
      undefined, undefined, makeAssetRefResolver([A]),
    );
    expect(res.warnings.join('\n')).toMatch(/no asset in the manifest has it/);
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

  /** #292 — GUID SHAPE was the whole check, so a ref to an asset DELETED from the
   *  manifest validated clean and failed later, at load/render time. The resolver is
   *  injected because this module does no I/O; these cases pin all three of its states. */
  describe('manifest-resolution rule (#292)', () => {
    const DEAD = 'deadbeef-0000-1111-2222-333344445555';
    /** Mirrors the real resolvers: `ok` is a case-SENSITIVE hit, because that is what
     *  `resolveRef` does; a folded-case hit is reported as its own verdict. */
    const knows = (...guids: string[]): AssetRefResolver => {
      const exact = new Set(guids);
      const folded = new Set(guids.map((g) => g.toLowerCase()));
      return (ref): AssetRefVerdict => (
        exact.has(ref) ? 'ok' : folded.has(ref.toLowerCase()) ? 'case-mismatch' : 'missing'
      );
    };

    it('flags a well-formed GUID that no manifest asset has', () => {
      const res = validateSceneData(
        scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: DEAD } } }]),
        schema, undefined, knows(GUID),
      );
      expect(res.warnings.join('\n')).toMatch(/well-formed GUID but no asset in the manifest has it/);
      expect(res.warnings.join('\n')).toContain(DEAD);
      // It must say WHICH field, or the caller cannot act on it.
      expect(res.warnings.join('\n')).toMatch(/Renderable3D\.mesh/);
    });

    it('accepts a GUID the resolver knows', () => {
      const res = validateSceneData(
        scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: GUID } } }]),
        schema, undefined, knows(GUID),
      );
      expect(res.warnings).toEqual([]);
    });

    /** This case used to assert the OPPOSITE — "case-insensitive, like every other guid
     *  comparison" — and that expectation was wrong, which is why it is called out rather
     *  than quietly rewritten. `resolveRef` is `guidToEntry.get(ref)`, a case-SENSITIVE
     *  Map lookup over guids stored verbatim, while `isGuid`'s regex carries `/i`. So an
     *  uppercase-authored ref is well-formed, is NOT found at load, and a validator that
     *  passed it would vouch for a ref that silently fails — the exact false negative this
     *  whole check exists to remove. It gets its own message because "deleted or never
     *  imported" would send the author hunting a file they are looking at. */
    it('flags a guid that matches only when case is folded, with its OWN message', () => {
      const res = validateSceneData(
        scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: GUID.toUpperCase() } } }]),
        schema, undefined, knows(GUID),
      );
      expect(res.warnings.join('\n')).toMatch(/matches a manifest asset only when letter case is ignored/);
      expect(res.warnings.join('\n')).toMatch(/case-SENSITIVE/);
      // Must NOT claim the asset is gone — that is a different fix.
      expect(res.warnings.join('\n')).not.toMatch(/deleted or never imported/);
    });

    it('accepts an exact-case guid', () => {
      const res = validateSceneData(
        scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: GUID } } }]),
        schema, undefined, knows(GUID),
      );
      expect(res.warnings).toEqual([]);
    });

    /** The load-bearing one: absent resolver ⇒ the pre-#292 shape-only pass, NOT
     *  "everything is dangling". A caller that cannot answer must omit it, and this
     *  is what makes that safe. */
    it('checks nothing when no resolver is injected', () => {
      const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { Renderable3D: { mesh: DEAD } } }]), schema);
      expect(res.warnings).toEqual([]);
    });

    it('does not consult the resolver for external URLs or primitive sprite keywords', () => {
      const asked: string[] = [];
      const spy: AssetRefResolver = (ref) => { asked.push(ref); return 'missing'; };
      const s2: SceneSchema = { traits: {
        UIElement: { category: 'component', fields: { imageSrc: { type: 'string' } } },
        Renderable2D: { category: 'component', fields: { sprite: { type: 'string' } } },
      } };
      const res = validateSceneData(scene([
        { id: 1, name: 'A', traits: { UIElement: { imageSrc: 'https://x/y.png' } } },
        { id: 2, name: 'B', traits: { Renderable2D: { sprite: 'circle' } } },
      ]), s2, undefined, spy);
      expect(asked).toEqual([]);
      expect(res.warnings).toEqual([]);
    });

    /** A malformed ref is still the OLD message, not the new one — the two failures
     *  have different fixes ("write a GUID" vs "the asset is gone") and collapsing
     *  them would send the caller after the wrong thing. */
    it('reports a non-GUID ref with the shape message, not the resolution one', () => {
      const res = validateSceneData(
        scene([{ id: 1, name: 'X', traits: { Environment: { hdrPath: 'sky' } } }]),
        schema, undefined, knows(GUID),
      );
      expect(res.warnings.join('\n')).toMatch(/is not a GUID or URL/);
      expect(res.warnings.join('\n')).not.toMatch(/no asset in the manifest/);
    });

    /** #292 — the ref rule used to walk `entity.traits` ONLY, so the 56 ref fields
     *  authored inside prefab-instance `overrides` blocks across `games/` + `demos/`
     *  (27 `Renderable3D.mesh` + 27 `.material` in space-console alone) were checked by
     *  NOTHING: not for resolution, not even for GUID shape. `refFieldWarnings` is now
     *  one predicate serving both, so the exemptions cannot drift apart. */
    describe('prefab-instance overrides', () => {
      const instance = (overrides: unknown) => ({
        version: 8,
        entities: [{
          id: 1, name: 'Inst',
          traits: { PrefabInstance: { source: GUID, localId: 1, rootInstanceId: 1 } },
          overrides,
        }],
      });

      it('flags a dangling ref inside an override group, labelled by localId', () => {
        const res = validateSceneData(
          instance({ 3: { Renderable3D: { mesh: DEAD } } }), undefined, undefined, knows(GUID),
        );
        expect(res.warnings.join('\n')).toMatch(/overrides\[3\]\.Renderable3D\.mesh/);
        expect(res.warnings.join('\n')).toMatch(/no asset in the manifest has it/);
      });

      it('flags a literal asset path inside an override group (shape, no resolver needed)', () => {
        const res = validateSceneData(instance({ 3: { Renderable3D: { material: '/a/b.mat.json' } } }));
        expect(res.warnings.join('\n')).toMatch(/overrides\[3\]\.Renderable3D\.material: internal asset path/);
      });

      it('stays silent for a live ref in an override group', () => {
        const res = validateSceneData(
          instance({ 3: { Renderable3D: { mesh: GUID } } }), undefined, undefined, knows(GUID),
        );
        expect(res.warnings).toEqual([]);
      });

      /** The ref check must NOT be hostage to the UIElement early-continue that the
       *  inert-size check uses — most override groups touch no UIElement at all, which
       *  is exactly the shape a naive placement would skip. */
      it('checks a group that touches no UIElement', () => {
        const res = validateSceneData(
          instance({ 3: { ParticleEmitter: { effect: DEAD } } }), undefined, undefined, knows(GUID),
        );
        expect(res.warnings.join('\n')).toMatch(/overrides\[3\]\.ParticleEmitter\.effect/);
      });

      it('tolerates a malformed overrides bag without throwing', () => {
        for (const bad of [null, 7, 'x', [], { 3: null }, { 3: 7 }, { 3: { Renderable3D: 5 } }]) {
          expect(() => validateSceneData(instance(bad), undefined, undefined, knows(GUID))).not.toThrow();
        }
      });
    });

    it('reports an internal asset path with the path message, not the resolution one', () => {
      const res = validateSceneData(
        scene([{ id: 1, name: 'X', traits: { Renderable3D: { material: '/a/b.mat.json' } } }]),
        schema, undefined, knows(GUID),
      );
      expect(res.warnings.join('\n')).toMatch(/internal asset path/);
      expect(res.warnings.join('\n')).not.toMatch(/no asset in the manifest/);
    });
  });

  /** #231 — `UIElement.fontFamily` is a ref field now, which is the point of the whole
   *  change: the validator, `diagnose` and the build tree-shaker all read the SAME registry,
   *  so joining it is what makes a UI font ref checkable at all. A pre-#231 family name is
   *  reported as the non-GUID it is (the runtime still renders it — warn-but-load), and a
   *  literal font PATH is reported as the literal path it is, which the field-specific
   *  exclusion used to prevent. */
  describe('UIElement.fontFamily', () => {
    const uiSchema: SceneSchema = {
      traits: { UIElement: { category: 'component', fields: { fontFamily: { type: 'string' }, systemFont: { type: 'string' } } } },
    };

    it('accepts a font-asset GUID', () => {
      const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { UIElement: { fontFamily: GUID } } }]), uiSchema);
      expect(res.warnings).toEqual([]);
    });

    it('flags a legacy CSS family NAME', () => {
      const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { UIElement: { fontFamily: 'Varela Round' } } }]), uiSchema);
      expect(res.warnings.join('\n')).toMatch(/'Varela Round' is not a GUID or URL/);
    });

    it('flags a literal font path', () => {
      const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { UIElement: { fontFamily: '/games/x/assets/fonts/Inter.ttf' } } }]), uiSchema);
      expect(res.warnings.join('\n')).toMatch(/internal asset path .* references must be a GUID/);
    });

    it('does not flag systemFont — a CSS family name there is the point of the field', () => {
      const res = validateSceneData(scene([{ id: 1, name: 'X', traits: { UIElement: { systemFont: 'system-ui' } } }]), uiSchema);
      expect(res.warnings).toEqual([]);
    });
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

/** Issue #16 — an authored UIElement size on a stretched anchor axis is stored, shown,
 *  and then overwritten by the anchor's offsets. The Inspector greys the field out; a
 *  scene READ as JSON gets no such signal, so the validator says it. Schema omitted:
 *  the check is cross-trait and independent of the field-type pass. */
describe('validateSceneData — UIElement size inert under a stretched UIAnchor (#16)', () => {
  const band = (anchor: string, el: Record<string, unknown>) => scene([
    { id: 1, name: 'NarrationBand', traits: { UIElement: el, UIAnchor: { anchor } } },
  ]);

  it('warns on a width authored under a bottom-stretch anchor (the court case)', () => {
    const res = validateSceneData(band('bottom-stretch', { width: 90, widthUnit: '%' }));
    expect(res.warnings.join('\n')).toMatch(/UIElement\.width is inert.*bottom-stretch.*left\/right offsets.*90/s);
  });

  it('echoes the value WITH its unit, so the reader can find the field', () => {
    expect(validateSceneData(band('bottom-stretch', { width: 90, widthUnit: '%' })).warnings[0])
      .toMatch(/authored 90%$/);
    // ⚠️ A missing unit means '%' — `widthUnit` DEFAULTS to '%' and a scene save strips a field
    // equal to its default. This line asserted `90px` until #757's close-out; it was pinning a
    // falsehood, and the same wrong fallback was reporting 10 live false positives across
    // games/ + demos/ (see the absent-unit describe block below).
    expect(validateSceneData(band('bottom-stretch', { width: 90 })).warnings[0])
      .toMatch(/authored 90%$/);
  });

  it('names the top/bottom offsets for an inert height', () => {
    const res = validateSceneData(band('left-stretch', { height: 40 }));
    expect(res.warnings.join('\n')).toMatch(/UIElement\.height is inert.*top\/bottom offsets/s);
  });

  it('stays silent on the LIVE axis of a half-stretched anchor', () => {
    // top-stretch overwrites width only — an authored height there is real, and
    // warning about it would be a false positive that teaches people to ignore this.
    const res = validateSceneData(band('top-stretch', { height: 40 }));
    expect(res.warnings).toEqual([]);
  });

  it('warns about BOTH axes under a full stretch', () => {
    const res = validateSceneData(band('stretch', { width: 90, height: 40 }));
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings.join('\n')).toMatch(/width is inert/);
    expect(res.warnings.join('\n')).toMatch(/height is inert/);
  });

  it('ignores a 0 size — that is the unset default, not a claim about size', () => {
    // Every UIElement carries width:0/height:0 when unsized; warning on those would
    // fire on nearly every stretched element and drown the real signal.
    const res = validateSceneData(band('stretch', { width: 0, height: 0 }));
    expect(res.warnings).toEqual([]);
  });

  it('ignores 100% — "fill the parent" AGREES with stretch, and is what the editor writes', () => {
    // Measured before narrowing this: warning on 100% fired 102 times across games/ +
    // demos/ while the genuine traps numbered 3. A channel that is 97% false positives
    // is one nobody reads, so the neutral value is excluded by design.
    const res = validateSceneData(band('stretch', {
      width: 100, widthUnit: '%', height: 100, heightUnit: '%',
    }));
    expect(res.warnings).toEqual([]);
  });

  it('still warns on 100 PX — a pixel size is a real claim a stretch overrides', () => {
    const res = validateSceneData(band('stretch', { width: 100, widthUnit: 'px' }));
    expect(res.warnings.join('\n')).toMatch(/UIElement\.width is inert/);
  });

  it('warns on the two real traps this check exists for', () => {
    // court's NarrationBand and 3d-test's 2D — the values that read as intentional.
    expect(validateSceneData(band('bottom-stretch', { width: 90, widthUnit: '%' })).warnings)
      .toHaveLength(1);
    expect(validateSceneData(band('stretch', { width: 200, widthUnit: '%' })).warnings)
      .toHaveLength(1);
  });

  it('stays silent on a non-stretched anchor', () => {
    const res = validateSceneData(band('bottom', { width: 90, height: 40 }));
    expect(res.warnings).toEqual([]);
  });

  it('needs BOTH traits — a UIElement with no UIAnchor is unconstrained', () => {
    const res = validateSceneData(scene([{ id: 1, name: 'Free', traits: { UIElement: { width: 90 } } }]));
    expect(res.warnings).toEqual([]);
  });

  it('does not throw on a malformed anchor value', () => {
    const res = validateSceneData(band(42 as unknown as string, { width: 90 }));
    expect(res.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });
});

/** Issue #35 — the twin of #16 for a PREFAB INSTANCE. An instance's overridden
 *  fields live in the SIBLING `overrides` object (keyed by prefab localId → trait →
 *  field), not in `traits` (which for an instance carries only PrefabInstance /
 *  EntityAttributes), so the #16 check above never sees an instance's size or
 *  anchor. Resolving the prefab needs I/O this module doesn't do, so a resolver is
 *  caller-injected and optional. */
describe('validateSceneData — UIElement size inert under a stretched UIAnchor, prefab-instance overrides (#35)', () => {
  const PREFAB_GUID = 'b2c3d4e5-1111-2222-3333-444455556666';

  const instance = (overrides: Record<string, unknown>) => scene([
    {
      id: 1,
      name: 'Instance',
      traits: { PrefabInstance: { source: PREFAB_GUID, localId: 1, rootInstanceId: 1 } },
      overrides,
    },
  ]);

  const prefabWith = (entityTraits: Record<string, unknown>) => ({
    id: PREFAB_GUID,
    version: 1,
    name: 'Prefab',
    rootLocalId: 1,
    entities: [{ localId: 1, name: 'Root', traits: entityTraits }],
  });

  it('warns: anchor from the prefab, size overridden in the scene, resolver supplied', () => {
    const getPrefab: PrefabResolver = (ref) => (ref === PREFAB_GUID ? prefabWith({ UIAnchor: { anchor: 'bottom-stretch' } }) : undefined);
    const res = validateSceneData(instance({ 1: { UIElement: { width: 90, widthUnit: '%' } } }), undefined, getPrefab);
    expect(res.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.width is inert.*bottom-stretch.*from its prefab, localId 1.*left\/right offsets.*overridden 90%/s);
  });

  it('stays silent with NO resolver passed (conservative silence)', () => {
    const res = validateSceneData(instance({ 1: { UIElement: { width: 90, widthUnit: '%' } } }));
    expect(res.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });

  it('warns with NO resolver at all when anchor AND size are both in the same override group', () => {
    const res = validateSceneData(instance({
      1: { UIAnchor: { anchor: 'bottom-stretch' }, UIElement: { width: 90, widthUnit: '%' } },
    }));
    expect(res.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.width is inert/);
    // The anchor came from the override group itself, not the prefab — no "(from its prefab...)" note.
    expect(res.warnings.join('\n')).not.toMatch(/from its prefab/);
  });

  it('excludes 0 in the prefab path', () => {
    const getPrefab: PrefabResolver = () => prefabWith({ UIAnchor: { anchor: 'stretch' } });
    const res = validateSceneData(instance({ 1: { UIElement: { width: 0 } } }), undefined, getPrefab);
    expect(res.warnings).toEqual([]);
  });

  it('excludes 100% where the UNIT comes from the prefab (unit-merge case)', () => {
    const getPrefab: PrefabResolver = () => prefabWith({
      UIAnchor: { anchor: 'stretch' },
      UIElement: { widthUnit: '%' },
    });
    // Override only the numeric value; the '%' unit is merged in from the prefab.
    const res = validateSceneData(instance({ 1: { UIElement: { width: 100 } } }), undefined, getPrefab);
    expect(res.warnings).toEqual([]);
  });

  it('stays silent on a non-stretched prefab anchor', () => {
    const getPrefab: PrefabResolver = () => prefabWith({ UIAnchor: { anchor: 'bottom' } });
    const res = validateSceneData(instance({ 1: { UIElement: { width: 90, widthUnit: '%' } } }), undefined, getPrefab);
    expect(res.warnings).toEqual([]);
  });

  it('stays silent when the override group does not touch UIElement at all (prefab-side authoring, out of scope)', () => {
    const getPrefab: PrefabResolver = () => prefabWith({
      UIAnchor: { anchor: 'stretch' },
      UIElement: { width: 200, widthUnit: '%' },
    });
    const res = validateSceneData(instance({ 1: { Transform: { x: 1 } } }), undefined, getPrefab);
    expect(res.warnings).toEqual([]);
  });

  it('does not crash and does not warn when the resolver throws', () => {
    const getPrefab: PrefabResolver = () => { throw new Error('boom'); };
    expect(() => validateSceneData(instance({ 1: { UIElement: { width: 90, widthUnit: '%' } } }), undefined, getPrefab)).not.toThrow();
    const res = validateSceneData(instance({ 1: { UIElement: { width: 90, widthUnit: '%' } } }), undefined, getPrefab);
    expect(res.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });

  it('does not crash and does not warn when the resolver returns garbage', () => {
    const getPrefab: PrefabResolver = () => 'not a prefab object' as unknown;
    const res = validateSceneData(instance({ 1: { UIElement: { width: 90, widthUnit: '%' } } }), undefined, getPrefab);
    expect(res.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });

  it('names the top/bottom offsets for an inert HEIGHT (the other axis)', () => {
    const getPrefab: PrefabResolver = () => prefabWith({ UIAnchor: { anchor: 'left-stretch' } });
    const res = validateSceneData(instance({ 1: { UIElement: { height: 40, heightUnit: '%' } } }), undefined, getPrefab);
    expect(res.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.height is inert.*left-stretch.*top\/bottom offsets.*overridden 40%/s);
  });

  it('warns on a UNIT-only override, taking the value from the prefab', () => {
    // The override changes only `widthUnit`; the 90 comes from the prefab. The axis is
    // still touched by the override, and 90% is still inert — so this must warn, with
    // the merged value echoed.
    const getPrefab: PrefabResolver = () => prefabWith({
      UIAnchor: { anchor: 'bottom-stretch' },
      UIElement: { width: 90, widthUnit: 'px' },
    });
    const res = validateSceneData(instance({ 1: { UIElement: { widthUnit: '%' } } }), undefined, getPrefab);
    expect(res.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.width is inert.*overridden 90%/s);
  });

  it('lets an override ANCHOR win over the prefab: stretched prefab, non-stretched override', () => {
    const getPrefab: PrefabResolver = () => prefabWith({ UIAnchor: { anchor: 'bottom-stretch' } });
    const res = validateSceneData(instance({
      1: { UIAnchor: { anchor: 'bottom' }, UIElement: { width: 90, widthUnit: '%' } },
    }), undefined, getPrefab);
    // The override un-stretches the axis, so the authored width is LIVE — silence is correct.
    expect(res.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });

  it('reports each override group independently, naming its own localId', () => {
    const getPrefab: PrefabResolver = () => ({
      id: PREFAB_GUID, version: 1, name: 'Prefab', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'A', traits: { UIAnchor: { anchor: 'bottom-stretch' } } },
        { localId: 2, name: 'B', traits: { UIAnchor: { anchor: 'right-stretch' } } },
      ],
    });
    const res = validateSceneData(instance({
      1: { UIElement: { width: 90, widthUnit: '%' } },
      2: { UIElement: { height: 30, heightUnit: '%' } },
    }), undefined, getPrefab);
    expect(res.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.width is inert/);
    expect(res.warnings.join('\n')).toMatch(/overrides\[2\]\.UIElement\.height is inert/);
  });

  it('stays silent when the override localId has no matching prefab entity', () => {
    const getPrefab: PrefabResolver = () => prefabWith({ UIAnchor: { anchor: 'bottom-stretch' } }); // only localId 1
    const res = validateSceneData(instance({ 7: { UIElement: { width: 90, widthUnit: '%' } } }), undefined, getPrefab);
    expect(res.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });

  it('never calls the resolver when PrefabInstance.source is empty', () => {
    let calls = 0;
    const getPrefab: PrefabResolver = () => { calls++; return undefined; };
    const res = validateSceneData(scene([{
      id: 1, name: 'Instance',
      traits: { PrefabInstance: { source: '', localId: 1, rootInstanceId: 1 } },
      overrides: { 1: { UIElement: { width: 90, widthUnit: '%' } } },
    }]), undefined, getPrefab);
    expect(calls).toBe(0);
    expect(res.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });

  it('resolves the prefab ONCE per entity, not once per override group', () => {
    let calls = 0;
    const getPrefab: PrefabResolver = () => {
      calls++;
      return { id: PREFAB_GUID, version: 1, name: 'P', rootLocalId: 1, entities: [
        { localId: 1, traits: { UIAnchor: { anchor: 'stretch' } } },
        { localId: 2, traits: { UIAnchor: { anchor: 'stretch' } } },
        { localId: 3, traits: { UIAnchor: { anchor: 'stretch' } } },
      ] };
    };
    validateSceneData(instance({
      1: { UIElement: { width: 90, widthUnit: '%' } },
      2: { UIElement: { width: 80, widthUnit: '%' } },
      3: { UIElement: { width: 70, widthUnit: '%' } },
    }), undefined, getPrefab);
    expect(calls).toBe(1);
  });

  it('stays silent when the resolved prefab has no entities array', () => {
    const getPrefab: PrefabResolver = () => ({ id: PREFAB_GUID, version: 1, name: 'P', rootLocalId: 1 });
    const res = validateSceneData(instance({ 1: { UIElement: { width: 90, widthUnit: '%' } } }), undefined, getPrefab);
    expect(res.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });
});


/** Issue #757 — the margin half of the same class. `applyAnchorStyle` clears all four UIElement
 *  margins on ANY anchored element, so an authored value is discarded. A scene read as JSON gets
 *  the same signal the Inspector gate now gives. Schema omitted for the same reason as #16's
 *  block: the check is cross-trait and independent of the field-type pass. */
describe('validateSceneData — UIElement margin inert under any UIAnchor (#757)', () => {
  const box = (anchor: string | null, el: Record<string, unknown>) => scene([
    { id: 1, name: 'Panel', traits: anchor === null ? { UIElement: el } : { UIElement: el, UIAnchor: { anchor } } },
  ]);

  it('warns on an authored margin under an anchor', () => {
    const res = validateSceneData(box('center', { marginTop: 20 }));
    expect(res.warnings.join('\n')).toMatch(/UIElement\.marginTop is inert.*'center'.*all four margins.*20%/s);
  });

  it('⭐ warns under a NON-stretching anchor too — the difference from the size rule', () => {
    // isSizeInert only fires on a stretched axis; margin dies under every mode. A test using only
    // 'stretch' would pass against a wrongly per-mode predicate, so this pins a plain corner anchor.
    expect(validateSceneData(box('top-left', { marginLeft: 8 })).warnings.join('\n'))
      .toMatch(/marginLeft is inert/);
    expect(validateSceneData(box('bottom-right', { marginBottom: 8 })).warnings.join('\n'))
      .toMatch(/marginBottom is inert/);
  });

  it('reports all four sides independently', () => {
    const res = validateSceneData(box('stretch', { marginTop: 1, marginRight: 2, marginBottom: 3, marginLeft: 4 }));
    const joined = res.warnings.join('\n');
    for (const k of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft']) {
      expect(joined).toMatch(new RegExp(`UIElement\\.${k} is inert`));
    }
  });

  it('echoes the value WITH its unit, and an ABSENT unit means % — the trait default', () => {
    expect(validateSceneData(box('center', { marginTop: 5, marginTopUnit: '%' })).warnings[0])
      .toMatch(/5% is discarded$/);
    expect(validateSceneData(box('center', { marginTop: 5, marginTopUnit: 'px' })).warnings[0])
      .toMatch(/5px is discarded$/);
    // ⚠️ `marginTopUnit` defaults to '%' and a scene save STRIPS a field equal to its default, so
    // the absent-unit case is the COMMON on-disk shape for a percentage — not a px shorthand. An
    // earlier cut of this test asserted `5px` here and was pinning a falsehood.
    expect(validateSceneData(box('center', { marginTop: 5 })).warnings[0])
      .toMatch(/5% is discarded$/);
  });

  it('stays SILENT on a zero margin — the defaults are 0, so reporting them buries the real ones', () => {
    // Same noise-budget rule that excludes `0`/`100%` from the size warning. Every anchored element
    // in the repo carries four zero margins; warning on them would produce hundreds of findings.
    expect(validateSceneData(box('center', { marginTop: 0, marginLeft: 0 })).warnings).toEqual([]);
  });

  it('stays silent with NO anchor — flow layout is where margin actually works', () => {
    expect(validateSceneData(box(null, { marginTop: 20 })).warnings).toEqual([]);
  });
});


/** #757 close-out — the unit fallback the margin work inherited from the size check was wrong, and
 *  it was firing on shipping scenes. Every `UIElement` length unit defaults to '%'
 *  (`runtime/traits/UIElement.ts`), and a scene save strips a field equal to its trait default, so
 *  an ABSENT unit means '%'. Reading it as 'px' made `isNeutralSize` miss `width: 100`.
 *
 *  MEASURED over the real corpus: 10 warnings across 143 tracked scene/prefab files before the fix,
 *  0 after — `HUD`/`Chrome Buttons`/`MenuIconBar`/`AdBannerSlot` (games/court), `StatusRoot` +
 *  `HeartsRoot` x2 (games/sling), `HudLine`/`AdBannerSlot` (games/wordweave), `Title`
 *  (demos/particle-demo). All ten were `100` with no unit, i.e. a full-bleed 100% box the editor
 *  itself writes. */
describe('validateSceneData — an absent length unit means % , not px (#757 close-out)', () => {
  const band = (anchor: string, el: Record<string, unknown>) => scene([
    { id: 1, name: 'Band', traits: { UIElement: el, UIAnchor: { anchor } } },
  ]);

  it('⭐ width 100 with NO unit is neutral (100%) and must NOT warn — the 10 false positives', () => {
    expect(validateSceneData(band('top-stretch', { width: 100 })).warnings).toEqual([]);
  });

  it('an explicit 100% is neutral too — unchanged behaviour', () => {
    expect(validateSceneData(band('top-stretch', { width: 100, widthUnit: '%' })).warnings).toEqual([]);
  });

  it('⭐ but an explicit 100px is NOT neutral, and must still warn', () => {
    // The discriminating pair: the fix must not turn "absent means %" into "100 is always fine".
    const res = validateSceneData(band('top-stretch', { width: 100, widthUnit: 'px' }));
    expect(res.warnings.join('\n')).toMatch(/width is inert.*100px/s);
  });

  it('⭐ a genuine finding still fires — 90 with no unit is 90%, not neutral', () => {
    // Proof the fix suppresses only the neutral case. This is the shape the noise budget exists to
    // FIND (court's NarrationBand was the original), and it must survive.
    const res = validateSceneData(band('bottom-stretch', { width: 90 }));
    expect(res.warnings.join('\n')).toMatch(/width is inert.*authored 90%/s);
  });

  it('0 stays neutral whatever the unit', () => {
    expect(validateSceneData(band('top-stretch', { width: 0 })).warnings).toEqual([]);
    expect(validateSceneData(band('top-stretch', { width: 0, widthUnit: 'px' })).warnings).toEqual([]);
  });
});


/** #757 close-out — the prefab-instance OVERRIDE mirror for margin. The size mirror has had its own
 *  block since #35; the margin one shipped without cover, so these pin the three branches review
 *  named: the `prefabUel` fallback when only the unit is overridden, the `anchorFromPrefab` message
 *  arm, and the `0` exclusion for an override that CANCELS a prefab margin. */
describe('validateSceneData — margin inert on a prefab-instance override (#757)', () => {
  const P = 'c3d4e5f6-1111-2222-3333-444455556666';

  const instance = (overrides: Record<string, unknown>) => scene([
    {
      id: 1,
      name: 'Instance',
      traits: { PrefabInstance: { source: P, localId: 1, rootInstanceId: 1 } },
      overrides,
    },
  ]);

  const prefabWith = (entityTraits: Record<string, unknown>) => ({
    id: P, version: 1, name: 'Prefab', rootLocalId: 1,
    entities: [{ localId: 1, name: 'Root', traits: entityTraits }],
  });

  it('warns on a margin the OVERRIDE introduces, with the anchor coming from the prefab', () => {
    const getPrefab: PrefabResolver = () => prefabWith({ UIAnchor: { anchor: 'center' } });
    const res = validateSceneData(instance({ 1: { UIElement: { marginTop: 12, marginTopUnit: 'px' } } }), undefined, getPrefab);
    expect(res.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.marginTop is inert.*'center'.*from its prefab, localId 1.*overridden 12px/s);
  });

  it('warns with NO resolver when anchor AND margin are in the same override group', () => {
    const res = validateSceneData(instance({
      1: { UIAnchor: { anchor: 'top-left' }, UIElement: { marginLeft: 6, marginLeftUnit: 'px' } },
    }));
    expect(res.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.marginLeft is inert/);
    expect(res.warnings.join('\n')).not.toMatch(/from its prefab/);
  });

  it('stays silent with NO resolver passed (conservative silence)', () => {
    const res = validateSceneData(instance({ 1: { UIElement: { marginTop: 12, marginTopUnit: 'px' } } }));
    expect(res.warnings.filter((w) => /marginTop is inert/.test(w))).toEqual([]);
  });

  it('reads the VALUE from the prefab when the override touches only the unit', () => {
    // The `v = prefabUel?.[key]` fallback: overriding marginTopUnit alone still makes the prefab's
    // own value inert, and the message must quote that value rather than skipping the field.
    const getPrefab: PrefabResolver = () => prefabWith({ UIElement: { marginTop: 7 }, UIAnchor: { anchor: 'top-left' } });
    const res = validateSceneData(instance({ 1: { UIElement: { marginTopUnit: 'px' } } }), undefined, getPrefab);
    expect(res.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.marginTop is inert.*7px/s);
  });

  it('⭐ an override setting a margin to 0 to CANCEL a prefab margin stays silent', () => {
    // Zeroing is how an author opts OUT. Warning there would tell them off for doing the one thing
    // that actually works.
    const getPrefab: PrefabResolver = () => prefabWith({ UIElement: { marginTop: 9 }, UIAnchor: { anchor: 'center' } });
    const res = validateSceneData(instance({ 1: { UIElement: { marginTop: 0 } } }), undefined, getPrefab);
    expect(res.warnings.join('\n')).not.toMatch(/marginTop is inert/);
  });

  it('stays silent when the instance is not anchored at all', () => {
    const getPrefab: PrefabResolver = () => prefabWith({});
    const res = validateSceneData(instance({ 1: { UIElement: { marginTop: 12, marginTopUnit: 'px' } } }), undefined, getPrefab);
    expect(res.warnings.join('\n')).not.toMatch(/marginTop is inert/);
  });
});
