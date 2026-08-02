// @vitest-environment jsdom
/** devTestBridge's `getPointerState()` — the E2E-facing read of the live `Input.pointer`
 *  resource (added alongside the pointer-block-root feature so `game-view-pointer-block.spec.ts`
 *  can assert against the real ECS state, not a proxy for it). No other test in this file's
 *  suite touches `devTestBridge.ts` at all, so this covers only the one method this change
 *  added — not a backfill of the rest of the (pre-existing, untested) bridge. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { Input } from '../../src/runtime/traits/Input';
import { installEditorTestBridge } from '../../src/editor/devTestBridge';

type Bridge = { getPointerState(): { down: boolean; pressed: boolean; x: number; y: number } | null };

let world: ReturnType<typeof createWorld> | undefined;

beforeEach(() => {
  installEditorTestBridge();
});
afterEach(() => {
  world = undefined;
});

function bridge(): Bridge {
  return (window as unknown as { __modokiEditorTest: Bridge }).__modokiEditorTest;
}

describe('devTestBridge.getPointerState', () => {
  it('returns null when no Input resource is spawned', () => {
    world = createWorld();
    setCurrentWorld(world);
    expect(bridge().getPointerState()).toBeNull();
  });

  it('reads the live pointer level state off the spawned Input resource', () => {
    world = createWorld();
    setCurrentWorld(world);
    const e = world.spawn(Input);
    // e was just spawned with Input, so the trait is guaranteed present.
    const input = e.get(Input)!;
    input.pointer.down = true;
    input.pointer.pressed = true;
    input.pointer.x = 123;
    input.pointer.y = 45;

    expect(bridge().getPointerState()).toEqual({ down: true, pressed: true, x: 123, y: 45 });
  });

  it('reflects a later mutation of the same resource (live read, not a snapshot)', () => {
    world = createWorld();
    setCurrentWorld(world);
    const e = world.spawn(Input);
    expect(bridge().getPointerState()?.down).toBe(false);

    e.get(Input)!.pointer.down = true;
    expect(bridge().getPointerState()?.down).toBe(true);
  });
});
