/** Trait schema verification — verifies all non-UI traits are properly defined. */

import { describe, it, expect } from 'vitest';

async function getTraits() {
  return import('../../../src/runtime/traits');
}

describe('Transform', () => {
  it('is defined with position/rotation/scale defaults', async () => {
    const { Transform } = await getTraits();
    expect(Transform).toBeDefined();
    const schema = (Transform as any).schema;
    // Position
    expect(schema.x).toBe(0);
    expect(schema.y).toBe(0);
    expect(schema.z).toBe(0);
    // Rotation (radians)
    expect(schema.rx).toBe(0);
    expect(schema.ry).toBe(0);
    expect(schema.rz).toBe(0);
    // Scale (uniform 1)
    expect(schema.sx).toBe(1);
    expect(schema.sy).toBe(1);
    expect(schema.sz).toBe(1);
  });

  it('can be called as a function', async () => {
    const { Transform } = await getTraits();
    const data = Transform();
    expect(data).toBeDefined();
  });
});

describe('EntityAttributes', () => {
  it('is defined with name, active, sortOrder, parentId, layer, guid defaults', async () => {
    const { EntityAttributes } = await getTraits();
    expect(EntityAttributes).toBeDefined();
    const schema = (EntityAttributes as any).schema;
    expect(schema.name).toBe('');
    expect(schema.isActive).toBe(true);
    expect(schema.sortOrder).toBe(0);
    expect(schema.parentId).toBe(0);
    expect(schema.layer).toBe('');
    expect(schema.guid).toBe('');
  });

  it('can be called as a function', async () => {
    const { EntityAttributes } = await getTraits();
    const data = EntityAttributes();
    expect(data).toBeDefined();
  });
});

describe('Camera', () => {
  it('is defined with fov, near, far, overlayDistance, clearColor defaults', async () => {
    const { Camera } = await getTraits();
    expect(Camera).toBeDefined();
    const schema = (Camera as any).schema;
    expect(schema.fov).toBe(30);
    expect(schema.near).toBe(0.1);
    expect(schema.far).toBe(500);
    expect(schema.overlayDistance).toBe(3);
    expect(schema.clearColor).toBe(0x000000);
  });

  it('can be called as a function', async () => {
    const { Camera } = await getTraits();
    const data = Camera();
    expect(data).toBeDefined();
  });
});

describe('Canvas2D', () => {
  it('is defined with referenceWidth, referenceHeight, scaleMode defaults', async () => {
    const { Canvas2D } = await getTraits();
    expect(Canvas2D).toBeDefined();
    const schema = (Canvas2D as any).schema;
    expect(schema.referenceWidth).toBe(1080);
    expect(schema.referenceHeight).toBe(1920);
    expect(schema.scaleMode).toBe('fitH');
  });

  it('can be called as a function', async () => {
    const { Canvas2D } = await getTraits();
    const data = Canvas2D();
    expect(data).toBeDefined();
  });
});

describe('ModelSource', () => {
  it('is defined with glbPath, postprocessor, prefix defaults', async () => {
    const { ModelSource } = await getTraits();
    expect(ModelSource).toBeDefined();
    const schema = (ModelSource as any).schema;
    expect(schema.glbPath).toBe('');
    expect(schema.postprocessor).toBe('none');
    expect(schema.prefix).toBe('');
  });

  it('can be called as a function', async () => {
    const { ModelSource } = await getTraits();
    const data = ModelSource();
    expect(data).toBeDefined();
  });
});

describe('Paused', () => {
  it('is defined as a tag trait (empty schema)', async () => {
    const { Paused } = await getTraits();
    expect(Paused).toBeDefined();
    const schema = (Paused as any).schema;
    expect(schema).toEqual({});
  });

  it('can be called as a function', async () => {
    const { Paused } = await getTraits();
    const data = Paused();
    expect(data).toBeDefined();
  });
});

describe('Persistent', () => {
  it('is defined as a marker (no fields)', async () => {
    const { Persistent } = await getTraits();
    expect(Persistent).toBeDefined();
    const schema = (Persistent as any).schema;
    expect(schema).toEqual({});
  });

  it('can be called as a function', async () => {
    const { Persistent } = await getTraits();
    const data = Persistent();
    expect(data).toBeDefined();
  });
});

describe('PrefabInstance', () => {
  it('is defined with source, localId, rootInstanceId defaults', async () => {
    const { PrefabInstance } = await getTraits();
    expect(PrefabInstance).toBeDefined();
    const schema = (PrefabInstance as any).schema;
    expect(schema.source).toBe('');
    expect(schema.localId).toBe(0);
    expect(schema.rootInstanceId).toBe(0);
  });

  it('can be called as a function', async () => {
    const { PrefabInstance } = await getTraits();
    const data = PrefabInstance();
    expect(data).toBeDefined();
  });
});

describe('Renderable2D', () => {
  it('is defined with sprite, color, size, pivot defaults', async () => {
    const { Renderable2D } = await getTraits();
    expect(Renderable2D).toBeDefined();
    const schema = (Renderable2D as any).schema;
    expect(schema.sprite).toBe('');
    expect(schema.color).toBe(0xffffff);
    expect(schema.width).toBe(20);
    expect(schema.height).toBe(20);
    expect(schema.pivotX).toBe(0.5);
    expect(schema.pivotY).toBe(0.5);
    expect(schema.keepAspect).toBe(false);
    expect(schema.isVisible).toBe(true);
  });

  it('can be called as a function', async () => {
    const { Renderable2D } = await getTraits();
    const data = Renderable2D();
    expect(data).toBeDefined();
  });
});

describe('Renderable3D', () => {
  it('is defined with mesh, material, isVisible defaults', async () => {
    const { Renderable3D } = await getTraits();
    expect(Renderable3D).toBeDefined();
    const schema = (Renderable3D as any).schema;
    expect(schema.mesh).toBe('');
    expect(schema.material).toBe('');
    expect(schema.isVisible).toBe(true);
  });

  it('can be called as a function', async () => {
    const { Renderable3D } = await getTraits();
    const data = Renderable3D();
    expect(data).toBeDefined();
  });
});

describe('Renderable3DPrimitive', () => {
  it('is defined with mesh, color, size, material, isVisible defaults', async () => {
    const { Renderable3DPrimitive } = await getTraits();
    expect(Renderable3DPrimitive).toBeDefined();
    const schema = (Renderable3DPrimitive as any).schema;
    expect(schema.mesh).toBe('cube');
    expect(schema.color).toBe(0xffffff);
    expect(schema.size).toBe(1);
    expect(schema.material).toBe('');
    expect(schema.isVisible).toBe(true);
  });

  it('can be called as a function', async () => {
    const { Renderable3DPrimitive } = await getTraits();
    const data = Renderable3DPrimitive();
    expect(data).toBeDefined();
  });
});

describe('RenderableUI', () => {
  it('is defined as a tag trait (empty schema)', async () => {
    const { RenderableUI } = await getTraits();
    expect(RenderableUI).toBeDefined();
    const schema = (RenderableUI as any).schema;
    expect(schema).toEqual({});
  });

  it('can be called as a function', async () => {
    const { RenderableUI } = await getTraits();
    const data = RenderableUI();
    expect(data).toBeDefined();
  });
});

describe('Time', () => {
  it('is defined with delta, elapsed, frame, smoothed defaults', async () => {
    const { Time } = await getTraits();
    expect(Time).toBeDefined();
    const schema = (Time as any).schema;
    expect(schema.delta).toBe(0);
    expect(schema.elapsed).toBe(0);
    expect(schema.frame).toBe(0);
    expect(schema.smoothedDelta).toBe(0);
    expect(schema.smoothedElapsed).toBe(0);
  });

  it('can be called as a function', async () => {
    const { Time } = await getTraits();
    const data = Time();
    expect(data).toBeDefined();
  });
});

describe('UIAction', () => {
  it('is defined with a bindings array', async () => {
    const { UIAction } = await getTraits();
    const { createWorld } = await import('koota');
    expect(UIAction).toBeDefined();
    // AoS trait (callback form) — read defaults by spawning, not via .schema.
    const w = createWorld();
    const data = w.spawn(UIAction()).get(UIAction) as any;
    expect(Array.isArray(data.bindings)).toBe(true);
    expect(data.bindings).toHaveLength(0);
    w.destroy();
  });

  it('can be called as a function', async () => {
    const { UIAction } = await getTraits();
    const data = UIAction();
    expect(data).toBeDefined();
  });

  it('gives each entity its own bindings array (no shared default)', async () => {
    const { UIAction } = await getTraits();
    const { createWorld } = await import('koota');
    const w = createWorld();
    const a = (w.spawn(UIAction()).get(UIAction) as any).bindings;
    const b = (w.spawn(UIAction()).get(UIAction) as any).bindings;
    expect(a).not.toBe(b);
    w.destroy();
  });
});

describe('UIAnchor', () => {
  it('is defined with anchor, offset, pivot, safeArea, zIndex defaults', async () => {
    const { UIAnchor } = await getTraits();
    expect(UIAnchor).toBeDefined();
    const schema = (UIAnchor as any).schema;
    expect(schema.anchor).toBe('stretch');
    expect(schema.top).toBe(0);
    expect(schema.topUnit).toBe('px');
    expect(schema.left).toBe(0);
    expect(schema.leftUnit).toBe('px');
    expect(schema.right).toBe(0);
    expect(schema.rightUnit).toBe('px');
    expect(schema.bottom).toBe(0);
    expect(schema.bottomUnit).toBe('px');
    expect(schema.pivotX).toBe(0);
    expect(schema.pivotY).toBe(0);
    expect(schema.safeArea).toBe(true);
    expect(schema.zIndex).toBe(0);
  });

  it('can be called as a function', async () => {
    const { UIAnchor } = await getTraits();
    const data = UIAnchor();
    expect(data).toBeDefined();
  });
});

describe('UIBinding', () => {
  it('is defined with binding fields', async () => {
    const { UIBinding } = await getTraits();
    expect(UIBinding).toBeDefined();
    const schema = (UIBinding as any).schema;
    expect(schema.textBinding).toBe('');
    expect(schema.inputBinding).toBe('');
  });

  it('can be called as a function', async () => {
    const { UIBinding } = await getTraits();
    const data = UIBinding();
    expect(data).toBeDefined();
  });
});

describe('clampAngle', () => {
  it('is exported from traits', async () => {
    const { clampAngle } = await getTraits();
    expect(clampAngle).toBeDefined();
    expect(typeof clampAngle).toBe('function');
  });

  it('passes through values within range', async () => {
    const { clampAngle } = await getTraits();
    expect(clampAngle(0)).toBe(0);
    expect(clampAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(clampAngle(-Math.PI)).toBeCloseTo(-Math.PI);
  });

  it('wraps values beyond 2pi', async () => {
    const { clampAngle } = await getTraits();
    const result = clampAngle(Math.PI * 3);
    expect(Math.abs(result)).toBeLessThanOrEqual(Math.PI * 2);
  });
});
