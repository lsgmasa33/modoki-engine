/** The 2D sprite KEYWORDS — the `Renderable2D.sprite` values that are legal without being a
 *  GUID or a URL — live in two places, and this keeps them honest.
 *
 *  `runtime/loaders/sceneValidation.ts` cannot import `rendering/render2DUtils.ts`: the
 *  validator is deliberately dependency-light so the dev server can run it in Node
 *  (`/api/validate-scene`), while `render2DUtils` reaches the texture provider and PixiJS. So
 *  the sentinel is COPIED, and a copy needs a test — the same forced-duplication shape
 *  `assetPathPredicate.test.ts` guards for the asset-extension lists.
 *
 *  The drift this catches already happened: `COLLIDER_SPRITE` ('collider' — draw the entity's
 *  own Collider2D outline, the visible body of a polygon/polyline collider) was absent from the
 *  validator's set, so both committed uses in `demos/2d-physics-demo` were reported as
 *  "'collider' is not a GUID or URL" on every load, and `modoki_validate_scene` called those
 *  scenes broken when they are not. Found by #231's close-out sweep. */
import { describe, it, expect } from 'vitest';
import { validateSceneData, PRIMITIVE_SPRITE_NAMES } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { COLLIDER_SPRITE } from '../../packages/modoki/src/runtime/rendering/render2DUtils';

const sceneWithSprite = (sprite: string) => ({
  version: 6,
  entities: [{ id: 1, name: 'Terrain', traits: { Renderable2D: { sprite } } }],
}) as never;

describe('Renderable2D.sprite keywords', () => {
  it('the validator accepts the collider sentinel, whatever render2DUtils calls it', () => {
    expect(validateSceneData(sceneWithSprite(COLLIDER_SPRITE)).warnings).toEqual([]);
  });

  it('accepts every primitive shape', () => {
    for (const name of PRIMITIVE_SPRITE_NAMES) {
      expect(validateSceneData(sceneWithSprite(name)).warnings, name).toEqual([]);
    }
  });

  /** The exemption must stay a LIST, not "any bare word": an unresolvable sprite renders
   *  nothing, and the warning is the only thing that says so. */
  it('still rejects an arbitrary word', () => {
    expect(validateSceneData(sceneWithSprite('terrain')).warnings.join('\n'))
      .toMatch(/'terrain' is not a GUID or URL/);
  });

  /** `create_entity` validates its `shape` against the NARROWER list on purpose: `collider`
   *  draws nothing without a `Collider2D` on the same entity, so accepting it there would be a
   *  successful-looking call that renders nothing — the false-success class. */
  it('the create_entity shape list stays narrower — collider is not a shape', () => {
    expect((PRIMITIVE_SPRITE_NAMES as readonly string[])).not.toContain(COLLIDER_SPRITE);
  });
});
