/** entityCreateSpecs — the "Create …" trait-spec builders extracted from
 *  Hierarchy.tsx so the menus AND the agent create-entity op build identical
 *  entities. These assertions pin the spec shape the inline handlers used to
 *  produce, so a future drift between the two surfaces is caught. */

import { describe, it, expect } from 'vitest';
import {
  emptySpecs, primitiveSpecs, shape2DSpecs, canvas2DSpecs, cameraSpecs, lightSpecs, environmentSpecs, particleSpecs,
  buildEntityCreateSpecs, type CreateSpecs,
} from '@modoki/engine/editor';

const traitNames = (s: CreateSpecs) => s.specs.map((t) => t.name);

describe('entityCreateSpecs builders', () => {
  it('empty → Transform + EntityAttributes only', () => {
    const s = emptySpecs(0);
    expect(s.name).toBe('New Entity');
    expect(traitNames(s)).toEqual(['Transform', 'EntityAttributes']);
    expect(s.specs[1].data).toMatchObject({ name: 'New Entity', parentId: 0 });
  });

  it('primitive → 3d Renderable3DPrimitive with capitalized name', () => {
    const s = primitiveSpecs('sphere', 4);
    expect(s.name).toBe('Sphere');
    expect(traitNames(s)).toEqual(['Transform', 'EntityAttributes', 'Renderable3DPrimitive']);
    expect(s.specs[1].data).toMatchObject({ name: 'Sphere', parentId: 4, layer: '3d' });
    expect(s.specs[2].data).toMatchObject({ mesh: 'sphere', size: 1, color: 0x888888, isVisible: true });
  });

  it('2d → 2d-layer Renderable2D', () => {
    const s = shape2DSpecs('circle', 0);
    expect(s.name).toBe('Circle 2D');
    expect(s.specs[1].data).toMatchObject({ layer: '2d' });
    expect(s.specs[2].data).toMatchObject({ sprite: 'circle', width: 20, height: 20, isVisible: true });
  });

  it('canvas2d → ui-layer Canvas2D host (RenderableUI + UIElement + UIAnchor + Canvas2D)', () => {
    const s = canvas2DSpecs(3);
    expect(s.name).toBe('2D Canvas');
    expect(traitNames(s)).toEqual(['EntityAttributes', 'RenderableUI', 'UIAnchor', 'UIElement', 'Canvas2D']);
    expect(s.specs[0].data).toMatchObject({ name: '2D Canvas', parentId: 3, layer: 'ui' });
    expect(s.specs[2].data).toMatchObject({ anchor: 'stretch' });
  });

  it('camera → Camera trait + offset transform', () => {
    const s = cameraSpecs(0);
    expect(traitNames(s)).toEqual(['Transform', 'EntityAttributes', 'Camera']);
    expect(s.specs[0].data).toMatchObject({ x: 0, y: 2, z: 10 });
  });

  it('light → kind-specific defaults; directional gets an offset transform', () => {
    const dir = lightSpecs('directional', 0);
    expect(dir.name).toBe('Directional Light');
    expect(dir.specs[0].data).toMatchObject({ x: 5, y: 10, z: 5 });
    expect(dir.specs[2].data).toMatchObject({ lightType: 'directional', intensity: 1 });
    const spot = lightSpecs('spot', 0);
    expect(spot.specs[2].data).toMatchObject({ lightType: 'spot', angle: 0.5, penumbra: 0.2 });
  });

  it('particle → empty ParticleEmitter', () => {
    const s = particleSpecs(2);
    expect(traitNames(s)).toEqual(['Transform', 'EntityAttributes', 'ParticleEmitter']);
    expect(s.specs[2].data).toEqual({});
  });

  it('environment → EntityAttributes + empty Environment (no Transform)', () => {
    const s = environmentSpecs(2);
    expect(s.name).toBe('HDR Environment');
    expect(traitNames(s)).toEqual(['EntityAttributes', 'Environment']);
    expect(s.specs[0].data).toMatchObject({ name: 'HDR Environment', parentId: 2 });
    expect(s.specs[1].data).toEqual({});
  });
});

describe('buildEntityCreateSpecs dispatcher (agent create-entity op)', () => {
  it('routes each kind to the matching builder', () => {
    expect(buildEntityCreateSpecs({ kind: 'empty' }, 0)).toEqual(emptySpecs(0));
    expect(buildEntityCreateSpecs({ kind: 'primitive', mesh: 'cone' }, 1)).toEqual(primitiveSpecs('cone', 1));
    expect(buildEntityCreateSpecs({ kind: '2d', shape: 'triangle' }, 0)).toEqual(shape2DSpecs('triangle', 0));
    expect(buildEntityCreateSpecs({ kind: 'canvas2d' }, 3)).toEqual(canvas2DSpecs(3));
    expect(buildEntityCreateSpecs({ kind: 'camera' }, 0)).toEqual(cameraSpecs(0));
    expect(buildEntityCreateSpecs({ kind: 'light', light: 'point' }, 0)).toEqual(lightSpecs('point', 0));
    expect(buildEntityCreateSpecs({ kind: 'particle' }, 0)).toEqual(particleSpecs(0));
    expect(buildEntityCreateSpecs({ kind: 'environment' }, 0)).toEqual(environmentSpecs(0));
  });

  it('ui kind produces a UIElement-bearing spec (anchor-first)', () => {
    const s = buildEntityCreateSpecs({ kind: 'ui', preset: 'button' }, 0);
    expect(s.specs.map((t) => t.name)).toContain('UIElement');
  });
});
