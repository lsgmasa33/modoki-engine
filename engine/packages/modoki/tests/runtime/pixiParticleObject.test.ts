/**
 * Integration tests for the PixiJS v8 2D particle render primitive
 * (`createPixiParticles`). Runs against REAL pixi.js objects in the default node
 * vitest env — pixi.js constructs `ParticleContainer`/`Particle`/`Texture.EMPTY`
 * with no GL context, so no jsdom is needed. Covers pool allocation, blend-mode +
 * renderOrder mapping, and the commit → live-prefix / hidden-tail behavior.
 */

import { describe, it, expect } from 'vitest';
import { createPixiParticles } from '../../src/runtime/particles/pixiParticleObject';
import { packColor } from '../../src/runtime/particles/pixiParticleMap';
import type { RenderConfig } from '../../src/runtime/particles/types';

function render(overrides: Partial<RenderConfig>): RenderConfig {
  return { blend: 'normal', ...overrides } as RenderConfig;
}

describe('createPixiParticles', () => {
  it('allocates a pool of maxParticles Particles', () => {
    const obj = createPixiParticles(50, render({ blend: 'additive' }));
    expect(obj.container.particleChildren.length).toBe(50);
    obj.dispose();
  });

  it('maps blend modes onto the PixiJS container blendMode', () => {
    const cases: Array<[RenderConfig['blend'], string]> = [
      ['additive', 'add'],
      ['multiply', 'multiply'],
      ['screen', 'screen'],
      ['normal', 'normal'],
    ];
    for (const [blend, expected] of cases) {
      const obj = createPixiParticles(4, render({ blend }));
      expect(obj.container.blendMode).toBe(expected);
      obj.dispose();
    }
  });

  it('maps renderOrder onto container zIndex', () => {
    const obj = createPixiParticles(4, render({ blend: 'normal', renderOrder: 7 }));
    expect(obj.container.zIndex).toBe(7);
    obj.dispose();
  });

  it('commit writes the live prefix and hides the dead tail', () => {
    const obj = createPixiParticles(50, render({ blend: 'normal' }));
    const { outputs } = obj;

    // Author 3 live particles at distinct positions/colors.
    for (let i = 0; i < 3; i++) {
      outputs.offsets[i * 3] = 10 + i; // x
      outputs.offsets[i * 3 + 1] = 20 + i; // y
      outputs.offsets[i * 3 + 2] = 0; // z (unused in 2D)
      outputs.scales[i] = 1;
      outputs.colors[i * 3] = 1; // r
      outputs.colors[i * 3 + 1] = 0; // g
      outputs.colors[i * 3 + 2] = 0; // b
      outputs.opacities[i] = 1;
      outputs.rotations[i] = 0;
    }

    obj.commit(3);

    const kids = obj.container.particleChildren;
    const expectedColor = packColor(1, 0, 0, 1); // opaque red
    for (let i = 0; i < 3; i++) {
      expect(kids[i].x).toBe(10 + i);
      expect(kids[i].y).toBe(20 + i); // identity map — sim IS screen space (axis-neutral, +Y-down)
      expect(kids[i].scaleX).toBe(1);
      expect(kids[i].scaleY).toBe(1);
      expect(kids[i].color).toBe(expectedColor);
    }
    // Every un-touched particle stays hidden.
    for (let i = 3; i < 50; i++) {
      expect(kids[i].scaleX).toBe(0);
      expect(kids[i].scaleY).toBe(0);
    }

    // Shrink to 1 alive → particles 1 and 2 become the newly-dead tail and are hidden.
    obj.commit(1);
    expect(kids[0].scaleX).toBe(1);
    expect(kids[0].scaleY).toBe(1);
    for (const i of [1, 2]) {
      expect(kids[i].scaleX).toBe(0);
      expect(kids[i].scaleY).toBe(0);
    }

    obj.dispose();
  });

  it('setQuad rewrites aspect/offset (applied on the next commit) and anchorY (applied immediately) (#769)', () => {
    const obj = createPixiParticles(4, render({ blend: 'normal', aspect: 1, anchor: 'center', offset: [0, 0] }));
    const { outputs } = obj;

    outputs.offsets[0] = 10; outputs.offsets[1] = 20; outputs.offsets[2] = 0;
    outputs.scales[0] = 2;
    outputs.colors[0] = 1; outputs.colors[1] = 1; outputs.colors[2] = 1;
    outputs.opacities[0] = 1;
    outputs.rotations[0] = 0;
    obj.commit(1);

    const p0 = obj.container.particleChildren[0];
    expect(p0.scaleX).toBe(2); // aspect=1: scaleX === scaleY === size
    expect(p0.anchorY).toBe(0.5); // center anchor

    obj.setQuad(render({ blend: 'normal', aspect: 2, anchor: 'bottom', offset: [3, 5] }));

    // anchorY is written straight onto the pooled particle — no commit needed.
    expect(p0.anchorY).toBe(1);
    // aspect/offset are mapping options, consumed only on the NEXT commit.
    expect(p0.scaleX).toBe(2); // unchanged yet
    expect(p0.x).toBe(10);

    obj.commit(1); // re-commit the same live particle to pick up the new mapping options
    expect(p0.scaleX).toBe(4); // scale(2) * new aspect(2)
    expect(p0.x).toBe(10 + 3 * 2); // offsets.x + offsetX(3) * scale(2)
    expect(p0.y).toBe(20 + 5 * 2); // offsets.y + offsetY(5) * scale(2)

    obj.dispose();
  });

  it('dispose does not throw', () => {
    const obj = createPixiParticles(8, render({ blend: 'additive' }));
    expect(() => obj.dispose()).not.toThrow();
  });
});
