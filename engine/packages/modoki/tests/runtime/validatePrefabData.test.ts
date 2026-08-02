/**
 * `validatePrefabData` — the prefab-side entry point for the inert-size rule (#42).
 *
 * The rule: a `UIElement.width`/`height` authored on an axis its `UIAnchor` STRETCHES is stored,
 * shown in the Inspector, and never applied, because a stretched axis is sized entirely by its two
 * offsets. Three places it can be authored — a plain scene entity (#16), a prefab instance's
 * scene-side overrides (#35), and inside the `.prefab.json` itself (this one, the last uncovered).
 *
 * The noise budget is the load-bearing part, and it is why these cases exist rather than a single
 * happy-path test: an unfiltered version of this check fired 102 times across `games/` + `demos/`
 * against 3 real findings. `0` and `100%` are excluded for that reason, so a test that only proved
 * "it warns" would let someone delete the exclusions and still pass.
 */

import { describe, it, expect } from 'vitest';
import { validatePrefabData } from '../../src/runtime/loaders/sceneValidation';

const prefab = (traits: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'feedface-0000-4000-8000-000000000001',
  version: 1,
  name: 'P',
  rootLocalId: 1,
  entities: [{ localId: 7, name: 'Band', traits, ...extra }],
});

describe('validatePrefabData — inert UI size inside a .prefab.json', () => {
  it('warns for a size on a STRETCHED axis, naming the localId, anchor and authored value', () => {
    const { warnings } = validatePrefabData(prefab({
      UIAnchor: { anchor: 'top-stretch' },
      UIElement: { width: 90, widthUnit: '%' },
    }));
    expect(warnings).toHaveLength(1);
    // localId is the identity a prefab entity actually has (parentId inside a prefab addresses
    // localIds, not ECS ids), so it must be in the message; the name is a convenience.
    expect(warnings[0]).toContain('localId=7');
    expect(warnings[0]).toContain('Band');
    expect(warnings[0]).toContain('top-stretch');
    // With its UNIT — '90' alone makes the author hunt for which field is meant.
    expect(warnings[0]).toContain('90%');
  });

  it('is SILENT on the axis the anchor does not stretch (axes are independent)', () => {
    // `top-stretch` stretches X only, so a height is perfectly live.
    const { warnings } = validatePrefabData(prefab({
      UIAnchor: { anchor: 'top-stretch' },
      UIElement: { height: 40, heightUnit: 'px' },
    }));
    expect(warnings).toEqual([]);
  });

  it('is SILENT for the two neutral values — this is the 102-vs-3 noise budget', () => {
    for (const uel of [
      { width: 0, widthUnit: 'px' },      // the "unset" default every UIElement carries
      { width: 100, widthUnit: '%' },     // "fill the parent" — AGREES with stretch, and is what
    ]) {                                  // the editor itself writes for a stretched element
      expect(validatePrefabData(prefab({ UIAnchor: { anchor: 'stretch' }, UIElement: uel })).warnings).toEqual([]);
    }
  });

  it('needs BOTH traits — a size with no anchor, or an anchor with no size, is not the trap', () => {
    expect(validatePrefabData(prefab({ UIElement: { width: 90, widthUnit: '%' } })).warnings).toEqual([]);
    expect(validatePrefabData(prefab({ UIAnchor: { anchor: 'stretch' } })).warnings).toEqual([]);
  });

  it('reports EVERY offending entity and both axes, not just the first', () => {
    const { warnings } = validatePrefabData({
      entities: [
        { localId: 1, traits: { UIAnchor: { anchor: 'stretch' }, UIElement: { width: 90, widthUnit: '%', height: 50, heightUnit: '%' } } },
        { localId: 2, traits: { UIAnchor: { anchor: 'top-stretch' }, UIElement: { width: 200, widthUnit: '%' } } },
      ],
    });
    // localId 1 stretches BOTH axes → 2 findings; localId 2 stretches X only → 1.
    expect(warnings).toHaveLength(3);
    expect(warnings.filter((w) => w.includes('localId=1'))).toHaveLength(2);
  });

  it('never throws on a malformed or foreign shape (warn-but-load contract)', () => {
    for (const bad of [null, undefined, 42, 'nope', {}, { entities: 'no' }, { entities: [null, 7, {}] }]) {
      expect(() => validatePrefabData(bad)).not.toThrow();
      expect(validatePrefabData(bad).warnings).toEqual([]);
    }
  });

  it('reports schemaApplied:false — it consults no trait schema and must not imply otherwise', () => {
    expect(validatePrefabData(prefab({})).schemaApplied).toBe(false);
  });
});
