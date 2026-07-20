/** Tests for engine trait registrations — verifies the engine registers all expected traits
 *  with correct field hints, and that a game-supplied resource trait registers via the same
 *  mechanism (exercised with an engine-owned fixture, not a demo game). */

import { describe, it, expect } from 'vitest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getTraitByName, getAllTraits } from '@modoki/engine/runtime';
import { registerTestGameTraits } from './_fixtures/testGame';

// Ensure traits are registered (engine + fixture game trait)
registerAllTraits();
registerTestGameTraits();

describe('registerTraits (engine + fixture game trait)', () => {
  it('registers core traits', () => {
    const names = getAllTraits().map((t) => t.name);
    expect(names).toContain('Transform');
    expect(names).toContain('Renderable3D');
    expect(names).toContain('Renderable3DPrimitive');
    expect(names).toContain('Renderable2D');
    expect(names).toContain('RenderableUI');
    expect(names).toContain('Camera');
    expect(names).toContain('TestPhase');
    expect(names).toContain('Time');
    expect(names).toContain('Paused');
  });

  it('Transform has grouped Position/Rotation/Scale fields', () => {
    const meta = getTraitByName('Transform')!;
    expect(meta.category).toBe('component');
    expect(meta.fields['x'].group).toBe('Position');
    expect(meta.fields['ry'].group).toBe('Rotation');
    expect(meta.fields['sz'].group).toBe('Scale');
    expect(meta.fields['x'].step).toBe(0.1);
    expect(meta.fields['rx'].step).toBe(1);
    expect(meta.fields['rx'].display).toBe('degrees');
  });

  it('Renderable3D has mesh and material fields', () => {
    const meta = getTraitByName('Renderable3D')!;
    expect(meta.fields['mesh'].type).toBe('string');
    expect(meta.fields['material'].type).toBe('string');
    expect(meta.fields['isVisible'].type).toBe('boolean');
  });

  it('Renderable3DPrimitive has enum mesh, material, color, and size fields', () => {
    const meta = getTraitByName('Renderable3DPrimitive')!;
    expect(meta.fields['mesh'].type).toBe('enum');
    expect(meta.fields['material'].type).toBe('string');
    expect(meta.fields['color'].type).toBe('color');
    expect(meta.fields['size'].type).toBe('number');
    expect(meta.fields['isVisible'].type).toBe('boolean');
  });

  it('Renderable2D has sprite, color, width, height, isVisible', () => {
    const meta = getTraitByName('Renderable2D')!;
    expect(meta.fields['sprite'].type).toBe('string');
    expect(meta.fields['color'].type).toBe('color');
    expect(meta.fields['width'].type).toBe('number');
    expect(meta.fields['height'].type).toBe('number');
    expect(meta.fields['isVisible'].type).toBe('boolean');
  });

  it('RenderableUI is a tag with no fields', () => {
    const meta = getTraitByName('RenderableUI')!;
    expect(meta.category).toBe('tag');
    expect(Object.keys(meta.fields)).toHaveLength(0);
  });

  it('EntityAttributes has parentId and layer', () => {
    const meta = getTraitByName('EntityAttributes')!;
    expect(meta.fields['parentId'].type).toBe('number');
    expect(meta.fields['layer'].type).toBe('enum');
    expect(meta.fields['layer'].options).toEqual(['', '3d', '2d', 'ui']);
  });

  it('Camera has camera role with fov/near/far', () => {
    const meta = getTraitByName('Camera')!;
    expect(meta.role).toBe('camera');
    expect(meta.fields['fov'].type).toBe('number');
    expect(meta.fields['near'].group).toBe('Clip');
    expect(meta.fields['far'].group).toBe('Clip');
  });

  it('Time is a resource with readOnly fields', () => {
    const meta = getTraitByName('Time')!;
    expect(meta.category).toBe('resource');
    expect(meta.fields['delta'].readOnly).toBe(true);
  });

  it('a game-supplied resource trait registers with its enum field (fixture)', () => {
    const meta = getTraitByName('TestPhase')!;
    expect(meta.category).toBe('resource');
    expect(meta.fields['phase'].options).toEqual(['home', 'game', 'result']);
  });

  it('Paused is a tag with no fields', () => {
    const meta = getTraitByName('Paused')!;
    expect(meta.category).toBe('tag');
    expect(Object.keys(meta.fields)).toHaveLength(0);
  });

  it('Director is an Animation component with a .timeline.json ref + read-back fields', () => {
    const meta = getTraitByName('Director')!;
    expect(meta.category).toBe('component');
    expect(meta.componentCategory).toBe('Animation');
    expect(meta.fields['timeline'].type).toBe('string');
    expect(meta.fields['timeline'].accept).toEqual(['.timeline.json']);
    expect(meta.fields['playing'].type).toBe('boolean');
    expect(meta.fields['lastTime'].runtimeOnly).toBe(true);
    expect(meta.fields['started'].runtimeOnly).toBe(true);
  });

  it('OnSequence exposes onStart/onEnd as UIAction pickers', () => {
    const meta = getTraitByName('OnSequence')!;
    expect(meta.componentCategory).toBe('Animation');
    expect(meta.fields['onStart'].optionsSource).toBe('uiActions');
    expect(meta.fields['onEnd'].optionsSource).toBe('uiActions');
  });

  it('UIAnchor sorts above UIElement in the Inspector (anchor-first authoring)', () => {
    // The Inspector renders trait sections by ascending priority, so a lower
    // number floats the section higher. Anchor (placement) must come before the
    // UIElement style/flex fields — Modoki authors think RectTransform-first.
    const anchor = getTraitByName('UIAnchor')!;
    const element = getTraitByName('UIElement')!;
    expect(anchor.priority).toBeLessThan(element.priority!);
    expect(anchor.componentCategory).toBe('UI');
  });
});
