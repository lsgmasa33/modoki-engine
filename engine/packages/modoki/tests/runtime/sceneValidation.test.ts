/** sceneValidation unit tests — structural checks, trait/field type checks, and
 *  the GUID asset-reference rule. Pure module, no world needed. */

import { describe, it, expect } from 'vitest';
import {
  validateSceneData, type SceneSchema, type PrefabResolver, type AssetRefResolver, type AssetRefVerdict,
  makeAssetRefResolver, lineHeightUnitWarnings, LINE_HEIGHT_MULTIPLIER_CEILING,
  collectEntryKindUses, entryBankWarnings, entryPrefabRootWarnings, type EntryKindUse,
  collapsedNewlineWarnings,
} from '../../src/runtime/loaders/sceneValidation';

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

/** #809 — `UIElement.lineHeight` is emitted in PIXELS, but was long documented (and authored) as a
 *  multiplier. `lineHeightUnitWarnings` fires on a plausible-multiplier value; the negative side
 *  matters more than the positive one, because the whole point of the flat ceiling (rather than a
 *  comparison against `fontSize`) is to survive real shipping content that a naive heuristic would
 *  flag. */
/** #676 — an authored newline the DOM collapses on the plain text path.
 *
 *  The two SKIP cases are the load-bearing half: `UINode` sets `white-space: pre-wrap` on the
 *  `AutoFitText` and `AnimatedText` spans (`autoFitText`, or the `TextAnimation` trait), so a
 *  newline there is honoured and authoring one is correct. Warning on those would be a false
 *  positive on legitimate multi-line text, which is the failure that teaches a reader to ignore
 *  the message — worse than the miss it prevents. `maxLines` is NOT one of the two: it clamps
 *  height only and sets no `white-space` of its own, so a newline under it still collapses. */
describe('collapsedNewlineWarnings (#676)', () => {
  const el = (uel: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
    ({ UIElement: uel, ...rest });

  it('warns on a multi-line text on the plain path, naming the line count', () => {
    const out = collapsedNewlineWarnings(el({ text: 'a\nb\nc' }), 'E');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/E\.UIElement\.text authors 3 lines/);
    expect(out[0]).toMatch(/render as one run-on paragraph/);
    // The message must point at the sanctioned fix, not at preserving the whitespace.
    expect(out[0]).toMatch(/sibling text elements/);
    expect(out[0]).toMatch(/do not add white-space/);
  });

  it('does NOT warn on single-line text, empty text, or a missing UIElement', () => {
    expect(collapsedNewlineWarnings(el({ text: 'one line' }), 'E')).toEqual([]);
    expect(collapsedNewlineWarnings(el({ text: '' }), 'E')).toEqual([]);
    expect(collapsedNewlineWarnings(el({}), 'E')).toEqual([]);
    expect(collapsedNewlineWarnings({}, 'E')).toEqual([]);
    expect(collapsedNewlineWarnings(null, 'E')).toEqual([]);
  });

  it('does NOT warn when the text reaches a pre-wrap span — autoFitText', () => {
    expect(collapsedNewlineWarnings(el({ text: 'a\nb', autoFitText: true }), 'E')).toEqual([]);
  });

  it('DOES warn on a positive maxLines — it clamps height, not whitespace (F2)', () => {
    // `maxLines` is NOT a pre-wrap path: UINode's `maxLines > 0` branch sets no `white-space` of
    // its own, so a newline collapses on it exactly like the plain path, whatever the value.
    expect(collapsedNewlineWarnings(el({ text: 'a\nb', maxLines: 2 }), 'E')).toHaveLength(1);
    expect(collapsedNewlineWarnings(el({ text: 'a\nb', maxLines: 0 }), 'E')).toHaveLength(1);
  });

  it('does NOT warn when the entity carries a TextAnimation', () => {
    expect(collapsedNewlineWarnings(el({ text: 'a\nb' }, { TextAnimation: { effect: 'typewriter' } }), 'E')).toEqual([]);
  });
});

describe('lineHeightUnitWarnings (#809)', () => {
  const el = (fields: Record<string, unknown>) => ({ UIElement: fields });

  it('fires on 1.4, naming the value and the pixel consequence', () => {
    const out = lineHeightUnitWarnings(el({ lineHeight: 1.4 }), "entity 'X'");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/entity 'X'\.UIElement\.lineHeight is 1\.4, which looks like a MULTIPLIER/);
    expect(out[0]).toMatch(/PIXELS.*1\.4px line box.*wrapped lines overlap/);
  });

  it('fires on 1.5 too', () => {
    expect(lineHeightUnitWarnings(el({ lineHeight: 1.5 }), 'X')).toHaveLength(1);
  });

  it('with a positive fontSize, appends the suggested pixel equivalent', () => {
    const out = lineHeightUnitWarnings(el({ lineHeight: 1.4, fontSize: 15 }), 'X');
    expect(out[0]).toMatch(/For fontSize 15 the equivalent is 21\.$/);
  });

  it('omits the suggestion when fontSize is absent, zero, or not a number', () => {
    expect(lineHeightUnitWarnings(el({ lineHeight: 1.4 }), 'X')[0]).not.toMatch(/For fontSize/);
    expect(lineHeightUnitWarnings(el({ lineHeight: 1.4, fontSize: 0 }), 'X')[0]).not.toMatch(/For fontSize/);
    expect(lineHeightUnitWarnings(el({ lineHeight: 1.4, fontSize: '15' }), 'X')[0]).not.toMatch(/For fontSize/);
  });

  it('does not fire on 0 — the authored "auto" sentinel', () => {
    expect(lineHeightUnitWarnings(el({ lineHeight: 0 }), 'X')).toEqual([]);
  });

  it('does not fire at the ceiling boundary — exclusive (>=, not >)', () => {
    expect(lineHeightUnitWarnings(el({ lineHeight: 4 }), 'X')).toEqual([]);
    expect(lineHeightUnitWarnings(el({ lineHeight: LINE_HEIGHT_MULTIPLIER_CEILING }), 'X')).toEqual([]);
  });

  it('does not fire on real pixel line heights above the ceiling', () => {
    for (const lh of [18, 19, 20, 21, 27]) {
      expect(lineHeightUnitWarnings(el({ lineHeight: lh }), 'X')).toEqual([]);
    }
  });

  it('⭐ does not fire on Court\'s real shapes — the regression that killed the fontSize-comparison heuristic', () => {
    // NarrationText: lineHeight 18 against fontSize 17. RefusalText: lineHeight 19 against
    // fontSize 19. The originally-proposed `lineHeight < fontSize` shape had ~1px of headroom on
    // exactly these two and would flip to a false positive under `<=`.
    expect(lineHeightUnitWarnings(el({ lineHeight: 18, fontSize: 17 }), 'NarrationText')).toEqual([]);
    expect(lineHeightUnitWarnings(el({ lineHeight: 19, fontSize: 19 }), 'RefusalText')).toEqual([]);
  });

  it('does not fire on a negative value — not this check\'s business', () => {
    expect(lineHeightUnitWarnings(el({ lineHeight: -5 }), 'X')).toEqual([]);
  });

  it('no UIElement / no lineHeight / a non-number lineHeight: no warnings, no throw', () => {
    expect(() => lineHeightUnitWarnings(null, 'X')).not.toThrow();
    expect(lineHeightUnitWarnings(null, 'X')).toEqual([]);
    expect(lineHeightUnitWarnings(undefined, 'X')).toEqual([]);
    expect(lineHeightUnitWarnings({}, 'X')).toEqual([]);
    expect(lineHeightUnitWarnings(el({}), 'X')).toEqual([]);
    expect(lineHeightUnitWarnings(el({ lineHeight: '1.4' }), 'X')).toEqual([]);
  });
});

/** #671 — resolving every `UIEntries` view -> entry-prefab edge from a scene. Pure parse over the
 *  bank; the delegation flags are the part worth pinning precisely, because they flip which half
 *  of `entryPrefabRootWarnings` below is even allowed to fire. */
describe('collectEntryKindUses (#671)', () => {
  const GUID_A = 'e5f6a7b8-1111-2222-3333-444455556666';
  const GUID_B = 'f6a7b8c9-1111-2222-3333-444455556666';
  const bank = (...kinds: { name: string; prefab: string }[]) => JSON.stringify(kinds);

  /** F4 — `entriesSystem.ts`'s `driveView` only ever reads `kinds[0]` (`prefabRootSize`,
   *  `ensurePool`, `applySlots`), so a bank's kinds `[1..]` are parsed but never actually spawned.
   *  Emitting a use per kind would claim kind `[1]`'s root is pinned every tick when the runtime
   *  never touches it at all. */
  it('a view with two kinds yields ONE use, for the first kind', () => {
    const entities = [{ name: 'LevelScroll', traits: { UIEntries: { prefabs: bank(
      { name: 'page', prefab: GUID_A }, { name: 'ad', prefab: GUID_B },
    ) } } }];
    const uses = collectEntryKindUses(entities, (_e, i) => `view[${i}]`);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ viewLabel: 'view[0]', kindName: 'page', prefabGuid: GUID_A });
  });

  it('entryWidth/entryHeight of 0 or ABSENT delegates; a non-zero value does not', () => {
    const withView = (extra: Record<string, unknown>) => collectEntryKindUses(
      [{ traits: { UIEntries: { prefabs: bank({ name: 'k', prefab: GUID_A }), ...extra } } }],
      () => 'v',
    )[0];
    expect(withView({}).delegatesWidth).toBe(true); // absent
    expect(withView({}).delegatesHeight).toBe(true); // absent
    expect(withView({ entryWidth: 0 }).delegatesWidth).toBe(true);
    expect(withView({ entryHeight: 0 }).delegatesHeight).toBe(true);
    expect(withView({ entryWidth: 120 }).delegatesWidth).toBe(false);
    expect(withView({ entryHeight: 80 }).delegatesHeight).toBe(false);
  });

  it('a UIEntries serialized as the tag shape (`true`) yields nothing', () => {
    expect(collectEntryKindUses([{ traits: { UIEntries: true } }], () => 'v')).toEqual([]);
  });

  it('an empty or absent bank yields nothing', () => {
    expect(collectEntryKindUses([{ traits: { UIEntries: { prefabs: '' } } }], () => 'v')).toEqual([]);
    expect(collectEntryKindUses([{ traits: { UIEntries: {} } }], () => 'v')).toEqual([]);
    expect(collectEntryKindUses([{ traits: {} }], () => 'v')).toEqual([]);
    expect(collectEntryKindUses([{}], () => 'v')).toEqual([]);
  });

  it('malformed bank JSON yields nothing and does not throw', () => {
    const entities = [{ traits: { UIEntries: { prefabs: '{not json' } } }];
    expect(() => collectEntryKindUses(entities, () => 'v')).not.toThrow();
    expect(collectEntryKindUses(entities, () => 'v')).toEqual([]);
  });
});

/** #671 — the `UIEntries.prefabs` bank's own JSON integrity: every failure shape
 *  `parseEntryPrefabs` silently drops, surfaced instead. */
describe('entryBankWarnings (#671)', () => {
  const GUID_A = 'a7b8c9d0-1111-2222-3333-444455556666';
  /** A DIFFERENT guid, used to build a manifest that does not contain `GUID_A`. */
  const GUID_B = 'b8c9d0e1-1111-2222-3333-444455556666';
  const traits = (prefabs: unknown) => ({ UIEntries: { prefabs } });

  it('the bank is not a string', () => {
    const out = entryBankWarnings(traits(42), 'V');
    expect(out.join('\n')).toMatch(/V\.UIEntries\.prefabs must be a JSON string, got number/);
  });

  it('the bank is not valid JSON', () => {
    const out = entryBankWarnings(traits('{not json'), 'V');
    expect(out.join('\n')).toMatch(/V\.UIEntries\.prefabs is not valid JSON — the whole entry bank is dropped/);
  });

  it('the bank is not a JSON array', () => {
    const out = entryBankWarnings(traits('{}'), 'V');
    expect(out.join('\n')).toMatch(/V\.UIEntries\.prefabs must be a JSON ARRAY of \{name, prefab\}/);
  });

  it('an entry that is not an object', () => {
    const out = entryBankWarnings(traits(JSON.stringify([42])), 'V');
    expect(out.join('\n')).toMatch(/V\.UIEntries\.prefabs\[0\] is not an object and is silently dropped/);
  });

  it('an entry missing its name', () => {
    const out = entryBankWarnings(traits(JSON.stringify([{ prefab: GUID_A }])), 'V');
    expect(out.join('\n')).toMatch(/V\.UIEntries\.prefabs\[0\]\.name is missing or empty/);
  });

  it('an entry missing its prefab', () => {
    const out = entryBankWarnings(traits(JSON.stringify([{ name: 'k' }])), 'V');
    expect(out.join('\n')).toMatch(/V\.UIEntries\.prefabs\[0\]\.prefab is missing or empty/);
  });

  it('a prefab that is not a GUID', () => {
    const out = entryBankWarnings(traits(JSON.stringify([{ name: 'k', prefab: 'nope' }])), 'V');
    expect(out.join('\n')).toMatch(/V\.UIEntries\.prefabs\[0\]\.prefab must be a prefab GUID, got 'nope'/);
    expect(out.join('\n')).not.toMatch(/asset PATH/);
  });

  it('a prefab authored as an internal asset PATH is called out explicitly', () => {
    const out = entryBankWarnings(traits(JSON.stringify([{ name: 'k', prefab: '/games/x/y.prefab.json' }])), 'V');
    expect(out.join('\n')).toMatch(/must be a prefab GUID.*\(an asset PATH — use the prefab's GUID\)/);
  });

  it('a clean bank produces no warnings', () => {
    expect(entryBankWarnings(traits(JSON.stringify([{ name: 'k', prefab: GUID_A }])), 'V')).toEqual([]);
  });

  it('an absent or empty bank, or no UIEntries at all, produces no warnings', () => {
    expect(entryBankWarnings({ UIEntries: {} }, 'V')).toEqual([]);
    expect(entryBankWarnings(traits(''), 'V')).toEqual([]);
    expect(entryBankWarnings({}, 'V')).toEqual([]);
    expect(entryBankWarnings(null, 'V')).toEqual([]);
  });

  describe('assetExists resolver', () => {
    it('a GUID the resolver confirms present produces no warning', () => {
      const resolver = makeAssetRefResolver([GUID_A]);
      expect(entryBankWarnings(traits(JSON.stringify([{ name: 'k', prefab: GUID_A }])), 'V', resolver))
        .toEqual([]);
    });

    /** ⚠️ These two exist because the first cut of this arm was DEAD CODE: it read
     *  `if (assetExists && !assetExists(prefab))`, and `AssetRefResolver` returns
     *  `'ok' | 'missing' | 'case-mismatch'` — three non-empty strings, all truthy — so the
     *  negation was false for every possible verdict and the warning could never fire. Nothing
     *  caught it except asking for the NEGATIVE case, which is the general lesson: a test suite
     *  that only proves a guard REJECTS bad input never proves it ACCEPTS the case it was built
     *  for. Keep both branches asserted separately; a single "it warns somehow" test would pass
     *  again on a resolver that collapsed the two verdicts. */
    it("a GUID the resolver reports 'missing' warns that the pool never spawns", () => {
      const resolver = makeAssetRefResolver([GUID_B]);
      const out = entryBankWarnings(traits(JSON.stringify([{ name: 'k', prefab: GUID_A }])), 'V', resolver);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/is a well-formed GUID but no asset in the manifest has it/);
      expect(out[0]).toMatch(/this kind's pool never spawns/);
    });

    it("a GUID that differs only in CASE gets the case-mismatch message, not the deleted one", () => {
      const resolver = makeAssetRefResolver([GUID_A.toUpperCase()]);
      const out = entryBankWarnings(traits(JSON.stringify([{ name: 'k', prefab: GUID_A }])), 'V', resolver);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/matches a manifest asset only when letter case is ignored/);
      // The distinction is the point: telling this author the asset was "deleted or never
      // imported" sends them hunting a file that is right there.
      expect(out[0]).not.toMatch(/deleted or never imported/);
    });
  });
});

/** #671 — the entry-PREFAB-ROOT half: what a pooled row's authored box looks like once
 *  `entriesSystem`'s per-tick pin has been applied to it. The conditional size rule (delegated vs
 *  not) is the part worth the most scrutiny — it is the whole reason this needs the view/prefab
 *  EDGE rather than a standalone per-prefab rule. */
describe('entryPrefabRootWarnings (#671)', () => {
  const use = (delegatesWidth: boolean, delegatesHeight: boolean): EntryKindUse => ({
    viewLabel: "entity 'LevelScroll'", kindName: 'page',
    prefabGuid: 'b8c9d0e1-1111-2222-3333-444455556666', delegatesWidth, delegatesHeight,
  });
  const root = (el: Record<string, unknown>) => ({ UIElement: el });

  it('a non-zero marginBottom on the root warns, ALWAYS discarded regardless of delegation', () => {
    const out = entryPrefabRootWarnings(use(true, true), root({ marginBottom: 8 }), 'entry prefab X');
    expect(out.join('\n')).toMatch(/entry prefab X\.UIElement\.marginBottom is inert/);
    expect(out.join('\n')).toMatch(/used as entry kind 'page' by entity 'LevelScroll'/);
    expect(out.join('\n')).toMatch(/margin pinned to 0 every tick — the authored 8 is discarded/);
  });

  it('isVisible:false warns; isVisible:true does not', () => {
    expect(entryPrefabRootWarnings(use(false, false), root({ isVisible: false }), 'X').join('\n'))
      .toMatch(/UIElement\.isVisible is inert/);
    expect(entryPrefabRootWarnings(use(false, false), root({ isVisible: true }), 'X')).toEqual([]);
  });

  it('minWidth/maxWidth/minHeight/maxHeight/flexShrink warn when non-zero', () => {
    for (const field of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'flexShrink']) {
      const out = entryPrefabRootWarnings(use(true, true), root({ [field]: 3 }), 'X');
      expect(out.join('\n')).toMatch(new RegExp(`UIElement\\.${field} is inert`));
    }
  });

  /** F3 — `flexShrink`'s trait DEFAULT (1) is not its pin (0), so `v === 0` alone falsely warns
   *  on an entry prefab root that never touched the field. Given the live schema (the same one
   *  `agentBridge`/`editorBackendRouter` push in production), an authored `flexShrink: 1` must be
   *  read as "untouched" and NOT warned about, while a genuinely authored `flexShrink: 2` still
   *  does. */
  it('flexShrink at its trait DEFAULT (1) does not warn when the schema is known; a real override does', () => {
    const uiElementSchema: SceneSchema = {
      traits: { UIElement: { category: 'component', fields: { flexShrink: { type: 'number', default: 1 } } } },
    };
    expect(entryPrefabRootWarnings(use(true, true), root({ flexShrink: 1 }), 'X', uiElementSchema))
      .toEqual([]);
    const out = entryPrefabRootWarnings(use(true, true), root({ flexShrink: 2 }), 'X', uiElementSchema);
    expect(out.join('\n')).toMatch(/UIElement\.flexShrink is inert/);
  });

  it('width on a DELEGATED axis does NOT warn — the view genuinely reads it', () => {
    expect(entryPrefabRootWarnings(use(true, false), root({ width: 90, widthUnit: '%' }), 'X'))
      .toEqual([]);
  });

  it('width on a NON-delegated axis DOES warn', () => {
    const out = entryPrefabRootWarnings(use(false, false), root({ width: 90, widthUnit: '%' }), 'X');
    expect(out.join('\n')).toMatch(/UIElement\.width is inert.*non-zero entryWidth.*authored 90%.*discarded.*Set entryWidth to 0/);
  });

  it('100% and 0 stay neutral on a non-delegated axis too (isNeutralSize) — real full-bleed roots', () => {
    expect(entryPrefabRootWarnings(use(false, false), root({ width: 100, widthUnit: '%' }), 'X')).toEqual([]);
    expect(entryPrefabRootWarnings(use(false, false), root({ width: 0 }), 'X')).toEqual([]);
    expect(entryPrefabRootWarnings(use(false, false), root({ height: 100, heightUnit: '%' }), 'X')).toEqual([]);
  });

  it('axes are independent: delegating width but not height warns about height only', () => {
    const out = entryPrefabRootWarnings(
      use(true, false), root({ width: 90, widthUnit: '%', height: 40, heightUnit: '%' }), 'X',
    );
    expect(out.join('\n')).not.toMatch(/UIElement\.width is inert/);
    expect(out.join('\n')).toMatch(/UIElement\.height is inert/);
  });

  it('no rootTraits, or a root with no UIElement: no warnings, no throw', () => {
    expect(entryPrefabRootWarnings(use(false, false), null, 'X')).toEqual([]);
    expect(entryPrefabRootWarnings(use(false, false), {}, 'X')).toEqual([]);
  });
});

/** #671 — the JOIN itself, exercised through `validateSceneData`: a `UIEntries` view plus a
 *  `getPrefab` resolver must reach `entryPrefabRootWarnings` for the prefab it actually uses. */
describe('validateSceneData — entry-kind pass (#671)', () => {
  const PREFAB_GUID = 'c9d0e1f2-1111-2222-3333-444455556666';
  const prefabWithMargin = {
    id: PREFAB_GUID, version: 1, name: 'EntryPrefab', rootLocalId: 1,
    entities: [{ localId: 1, name: 'Root', traits: { UIElement: { marginBottom: 8 } } }],
  };
  const bank = JSON.stringify([{ name: 'page', prefab: PREFAB_GUID }]);
  const sceneWithView = (name: string, extra: Record<string, unknown> = {}) => (
    { id: 1, name, traits: { UIEntries: { prefabs: bank, ...extra } } }
  );

  it('warns through the full scene pass when a getPrefab resolver is supplied', () => {
    const getPrefab: PrefabResolver = (ref) => (ref === PREFAB_GUID ? prefabWithMargin : undefined);
    const res = validateSceneData(scene([sceneWithView('LevelScroll')]), undefined, getPrefab);
    expect(res.warnings.join('\n')).toMatch(/entry prefab '.*'\.UIElement\.marginBottom is inert/);
    expect(res.warnings.join('\n')).toMatch(/entry kind 'page'/);
  });

  it('stays silent with NO getPrefab — the BYOD path', () => {
    const res = validateSceneData(scene([sceneWithView('LevelScroll')]));
    expect(res.warnings.filter((w) => /entry kind/.test(w))).toEqual([]);
  });

  it('de-dupes: two views pointing at the same prefab with the same delegation flags produce ONE warning', () => {
    const getPrefab: PrefabResolver = (ref) => (ref === PREFAB_GUID ? prefabWithMargin : undefined);
    const res = validateSceneData(scene([
      sceneWithView('ScrollA'),
      { id: 2, name: 'ScrollB', traits: { UIEntries: { prefabs: bank } } },
    ]), undefined, getPrefab);
    expect(res.warnings.filter((w) => /marginBottom is inert/.test(w))).toHaveLength(1);
  });

  it('different delegation flags for the SAME prefab are NOT merged by the de-dupe key', () => {
    const prefabWide = {
      id: PREFAB_GUID, version: 1, name: 'EntryPrefab', rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: { UIElement: { width: 90, widthUnit: '%' } } }],
    };
    const getPrefab: PrefabResolver = (ref) => (ref === PREFAB_GUID ? prefabWide : undefined);
    const res = validateSceneData(scene([
      // Delegates width (entryWidth: 0) — the prefab's own width is genuinely read, no warning.
      { id: 1, name: 'ScrollDelegates', traits: { UIEntries: { prefabs: bank, entryWidth: 0 } } },
      // Does not delegate — the authored 90% is discarded, warns.
      { id: 2, name: 'ScrollFixed', traits: { UIEntries: { prefabs: bank, entryWidth: 120 } } },
    ]), undefined, getPrefab);
    expect(res.warnings.filter((w) => /UIElement\.width is inert/.test(w))).toHaveLength(1);
  });
});

