/** Pure overflow-clamp math for the shared ContextMenu (editor-panels F11).
 *  The root component test (engine/tests/editor/contextMenu.test.tsx) covers
 *  rendering; these cover the position math that keeps a tall menu or a submenu
 *  near a viewport edge fully on-screen — measured post-layout, then clamped. */

import { describe, it, expect } from 'vitest';
import { clampMenuPosition, clampSubmenuPosition } from '../../src/editor/components/ContextMenu';

const VW = 1000;
const VH = 800;

describe('clampMenuPosition', () => {
  it('leaves a menu that fits in place', () => {
    expect(clampMenuPosition(100, 100, 160, 200, VW, VH)).toEqual({ left: 100, top: 100 });
  });

  it('shifts up when a tall menu would overflow the bottom edge', () => {
    // A 400px-tall menu opened at y=700 (vh=800) would run to 1100 → clamp top.
    const { top } = clampMenuPosition(100, 700, 160, 400, VW, VH);
    expect(top).toBe(VH - 400 - 8); // 392
  });

  it('shifts left when a menu would overflow the right edge', () => {
    const { left } = clampMenuPosition(950, 100, 160, 200, VW, VH);
    expect(left).toBe(VW - 160 - 8); // 832
  });

  it('never pushes the origin above the top-left margin', () => {
    // A menu taller/wider than the viewport pins at the margin, not negative.
    expect(clampMenuPosition(0, 0, 2000, 2000, VW, VH)).toEqual({ left: 8, top: 8 });
  });
});

describe('clampSubmenuPosition', () => {
  const row = { left: 200, right: 360, top: 300 };

  it('opens to the right of the row by default', () => {
    const { left, top } = clampSubmenuPosition(row, 140, 200, VW, VH);
    expect(left).toBe(row.right - 4); // 356
    expect(top).toBe(row.top);         // 300
  });

  it('flips to the left of the row when it would overflow the right edge', () => {
    const nearRight = { left: 880, right: 960, top: 300 };
    const { left } = clampSubmenuPosition(nearRight, 140, 200, VW, VH);
    // 960-4+140 = 1096 > 992 → flip: left edge of row + 4 - width.
    expect(left).toBe(nearRight.left + 4 - 140); // 744
  });

  it('shifts up when the submenu would overflow the bottom edge', () => {
    const lowRow = { left: 200, right: 360, top: 720 };
    const { top } = clampSubmenuPosition(lowRow, 140, 200, VW, VH);
    expect(top).toBe(VH - 200 - 8); // 592
  });

  it('clamps a flipped submenu to the left margin rather than going negative', () => {
    const nearLeftAndRight = { left: 10, right: 990, top: 300 };
    const { left } = clampSubmenuPosition(nearLeftAndRight, 140, 200, VW, VH);
    expect(left).toBe(8); // pinned to the margin
  });
});
