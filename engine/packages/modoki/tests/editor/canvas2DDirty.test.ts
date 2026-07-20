/** canvas2DDirty unit tests — the SceneView 2D overlay redraw signal.
 *
 *  The overlay renders one layer per Canvas2D entity. A single consumable boolean
 *  can only be claimed by ONE layer per dirty cycle (the rest would never redraw),
 *  so the store also exposes a monotonic version that each layer tracks
 *  independently. These tests pin that contract. */

import { describe, it, expect } from 'vitest';
import { mark2DDirty, get2DDirtyVersion, consume2DDirty, ensureCanvas2DListeners } from '../../src/editor/store/canvas2DDirty';
import { fireDirtyListeners } from '../../src/runtime/ecs/entityUtils';

describe('canvas2DDirty version counter', () => {
  it('bumps the version on every mark2DDirty', () => {
    const v0 = get2DDirtyVersion();
    mark2DDirty();
    const v1 = get2DDirtyVersion();
    mark2DDirty();
    const v2 = get2DDirtyVersion();
    expect(v1).toBeGreaterThan(v0);
    expect(v2).toBeGreaterThan(v1);
  });

  it('returns a stable version when nothing is marked', () => {
    const a = get2DDirtyVersion();
    const b = get2DDirtyVersion();
    expect(a).toBe(b);
  });

  it('lets multiple independent readers each observe the change (no starvation)', () => {
    // Two "layers" each remember the last version they drew.
    let layerA = get2DDirtyVersion();
    let layerB = get2DDirtyVersion();

    mark2DDirty();
    const v = get2DDirtyVersion();

    // Both layers see a change (the old boolean would have let only one consume it).
    expect(v).not.toBe(layerA);
    expect(v).not.toBe(layerB);

    layerA = v;
    layerB = v;
    // After both record it, neither redraws again until the next mark.
    expect(get2DDirtyVersion()).toBe(layerA);
    expect(get2DDirtyVersion()).toBe(layerB);
  });

  it('still supports the single-consumer boolean for legacy callers', () => {
    mark2DDirty();
    expect(consume2DDirty()).toBe(true);  // first claim wins
    expect(consume2DDirty()).toBe(false); // already consumed
    mark2DDirty();
    expect(consume2DDirty()).toBe(true);  // re-marking re-arms it
  });
});

describe('ensureCanvas2DListeners', () => {
  it('subscribes to ECS dirty events so an ECS write bumps the redraw version', () => {
    ensureCanvas2DListeners();
    const before = get2DDirtyVersion();
    fireDirtyListeners(); // simulate any ECS trait write
    expect(get2DDirtyVersion()).toBeGreaterThan(before);
  });

  it('is idempotent — a second call does not double-subscribe', () => {
    ensureCanvas2DListeners();
    ensureCanvas2DListeners(); // no-op (guarded by _initialized)
    const before = get2DDirtyVersion();
    fireDirtyListeners();
    // Exactly one bump, not two — proves only a single listener is attached.
    expect(get2DDirtyVersion()).toBe(before + 1);
  });
});
