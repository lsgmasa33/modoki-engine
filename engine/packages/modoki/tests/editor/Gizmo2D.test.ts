/** Gizmo2D unit tests — hitTestGizmo2D, cursorForHandle pure functions. */

import { describe, it, expect } from 'vitest';
import { hitTestGizmo2D, cursorForHandle, type GizmoHandle } from '../../src/editor/panels/Gizmo2D';

// Constants mirrored from source (not exported, so we duplicate)
const BASE_AXIS_LEN = 60;
const BASE_RING_TOLERANCE = 8;

describe('hitTestGizmo2D', () => {
  // Entity at origin, no rotation, scale 1, 100x100 entity
  const ex = 200, ey = 200, rz = 0, sx = 1, sy = 1, ew = 50, eh = 50;

  describe('translate mode', () => {
    const mode = 'translate' as const;
    const space = 'world' as const;

    it('returns x-axis when clicking on the x-axis handle', () => {
      // Handle is at (ex + AXIS_LEN, ey)
      const result = hitTestGizmo2D(ex + BASE_AXIS_LEN, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('x-axis');
    });

    it('returns y-axis when clicking on the y-axis handle', () => {
      // Handle is at (ex, ey + AXIS_LEN)
      const result = hitTestGizmo2D(ex, ey + BASE_AXIS_LEN, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('y-axis');
    });

    it('returns free when clicking at the center', () => {
      const result = hitTestGizmo2D(ex, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('free');
    });

    it('returns x-axis when clicking along the x-axis line', () => {
      // Click along the positive x-axis line, past the center zone
      const result = hitTestGizmo2D(ex + 30, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('x-axis');
    });

    it('returns x-axis when clicking along negative x-axis line', () => {
      const result = hitTestGizmo2D(ex - 30, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('x-axis');
    });

    it('returns y-axis when clicking along the y-axis line', () => {
      const result = hitTestGizmo2D(ex, ey + 30, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('y-axis');
    });

    it('returns null when clicking far from all handles', () => {
      const result = hitTestGizmo2D(ex + 200, ey + 200, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBeNull();
    });

    it('handles local space rotation', () => {
      // Rotate 90 degrees — x-axis is now pointing down, y-axis pointing left
      const rotated = Math.PI / 2;
      // Click where x-axis handle should be after rotation (below the entity)
      const result = hitTestGizmo2D(ex, ey + BASE_AXIS_LEN, ex, ey, rotated, sx, sy, ew, eh, mode, 'local');
      expect(result).toBe('x-axis');
    });

    it('respects screenScale', () => {
      const scale = 2;
      // At scale=2, axis length is 120, handle at (ex+120, ey)
      const result = hitTestGizmo2D(ex + 120, ey, ex, ey, rz, sx, sy, ew, eh, mode, space, scale);
      expect(result).toBe('x-axis');
    });
  });

  describe('rotate mode', () => {
    const mode = 'rotate' as const;
    const space = 'world' as const;

    it('returns rotate when clicking on the ring', () => {
      // Click on the ring at the right side
      const result = hitTestGizmo2D(ex + BASE_AXIS_LEN, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('rotate');
    });

    it('returns rotate when clicking on the ring at top', () => {
      const result = hitTestGizmo2D(ex, ey - BASE_AXIS_LEN, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('rotate');
    });

    it('returns null when clicking at center (inside ring)', () => {
      const result = hitTestGizmo2D(ex, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBeNull();
    });

    it('returns null when clicking far outside the ring', () => {
      const result = hitTestGizmo2D(ex + 200, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBeNull();
    });

    it('returns rotate within ring tolerance', () => {
      // Just inside the ring tolerance
      const result = hitTestGizmo2D(ex + BASE_AXIS_LEN + BASE_RING_TOLERANCE - 1, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('rotate');
    });
  });

  describe('scale mode', () => {
    const mode = 'scale' as const;
    const space = 'world' as const;

    it('returns scale-br when clicking bottom-right corner', () => {
      // Corner is at (ew * sx, eh * sy) = (50, 50) from entity center
      const result = hitTestGizmo2D(ex + 50, ey + 50, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('scale-br');
    });

    it('returns scale-tl when clicking top-left corner', () => {
      const result = hitTestGizmo2D(ex - 50, ey - 50, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('scale-tl');
    });

    it('returns scale-tr when clicking top-right corner', () => {
      const result = hitTestGizmo2D(ex + 50, ey - 50, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('scale-tr');
    });

    it('returns scale-bl when clicking bottom-left corner', () => {
      const result = hitTestGizmo2D(ex - 50, ey + 50, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('scale-bl');
    });

    it('returns scale-uniform when clicking the center diamond', () => {
      const result = hitTestGizmo2D(ex, ey, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBe('scale-uniform');
    });

    it('returns null when clicking between handles', () => {
      // Click midway between center and corner — not near any handle
      const result = hitTestGizmo2D(ex + 25, ey + 25, ex, ey, rz, sx, sy, ew, eh, mode, space);
      expect(result).toBeNull();
    });

    it('handles rotation in scale mode', () => {
      // Rotate 90 degrees — corners rotate too
      const rotated = Math.PI / 2;
      // Top-right corner (50, -50) rotated 90deg becomes (50, 50) in screen space
      // Actually: local (hw, -hh) rotated by rz. Hit test undoes rotation.
      // So clicking at the screen position of rotated top-right should still return scale-tr
      const cos_r = Math.cos(rotated);
      const sin_r = Math.sin(rotated);
      const hw = 50, hh = 50;
      // Rotated position of top-right corner (hw, -hh)
      const screenX = ex + hw * cos_r - (-hh) * sin_r;
      const screenY = ey + hw * sin_r + (-hh) * cos_r;
      const result = hitTestGizmo2D(screenX, screenY, ex, ey, rotated, sx, sy, ew, eh, mode, space);
      expect(result).toBe('scale-tr');
    });

    it('handles non-uniform scale', () => {
      // sx=2, sy=1 — corners at (100, 50), etc.
      const result = hitTestGizmo2D(ex + 100, ey + 50, ex, ey, rz, 2, sy, ew, eh, mode, space);
      expect(result).toBe('scale-br');
    });
  });
});

describe('cursorForHandle', () => {
  it('returns default for null', () => {
    expect(cursorForHandle(null)).toBe('default');
  });

  it('returns ew-resize for x-axis', () => {
    expect(cursorForHandle('x-axis')).toBe('ew-resize');
  });

  it('returns ns-resize for y-axis', () => {
    expect(cursorForHandle('y-axis')).toBe('ns-resize');
  });

  it('returns move for free', () => {
    expect(cursorForHandle('free')).toBe('move');
  });

  it('returns crosshair for rotate', () => {
    expect(cursorForHandle('rotate')).toBe('crosshair');
  });

  it('returns nwse-resize for scale-uniform', () => {
    expect(cursorForHandle('scale-uniform')).toBe('nwse-resize');
  });

  it('returns nwse-resize for scale-tl and scale-br (diagonal)', () => {
    expect(cursorForHandle('scale-tl')).toBe('nwse-resize');
    expect(cursorForHandle('scale-br')).toBe('nwse-resize');
  });

  it('returns nesw-resize for scale-tr and scale-bl (anti-diagonal)', () => {
    expect(cursorForHandle('scale-tr')).toBe('nesw-resize');
    expect(cursorForHandle('scale-bl')).toBe('nesw-resize');
  });

  it('maps all GizmoHandle values to non-default cursors', () => {
    const handles: GizmoHandle[] = [
      'x-axis', 'y-axis', 'free', 'rotate',
      'scale-uniform', 'scale-tl', 'scale-tr', 'scale-bl', 'scale-br',
    ];
    for (const h of handles) {
      expect(cursorForHandle(h)).not.toBe('default');
    }
  });
});
