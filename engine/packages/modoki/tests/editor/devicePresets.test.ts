/** Device preset data + search/orientation helpers. Guards the req-1 fix (logical
 *  resolution shown), catalog integrity (no bad entries — a wrong aspect silently
 *  mis-letterboxes every view), and the search/filter used by the device picker. */
import { describe, it, expect } from 'vitest';
import {
  DEVICE_PRESETS, FREE_PRESET, DEVICE_CATEGORY_ORDER, type DevicePreset,
  resolveLogicalSize, resolvePhysicalSize, presetDpr, presetLabel, filterDevices,
} from '../../src/editor/scene/devicePresets';

const devices = DEVICE_PRESETS.filter((p) => p.logicalW > 0);
const find = (name: string) => devices.find((d) => d.name === name)!;

describe('device catalog integrity', () => {
  it('has Free first, then real devices', () => {
    expect(DEVICE_PRESETS[0]).toBe(FREE_PRESET);
    expect(devices.length).toBeGreaterThanOrEqual(15);
  });

  it('every device has positive, same-DPR logical/physical dimensions', () => {
    for (const d of devices) {
      expect(d.logicalW).toBeGreaterThan(0);
      expect(d.logicalH).toBeGreaterThan(0);
      expect(d.physicalW).toBeGreaterThanOrEqual(d.logicalW);
      expect(d.physicalH).toBeGreaterThanOrEqual(d.logicalH);
      // Same DPR on both axes (no anamorphic pixels) — within rounding.
      expect(d.physicalW / d.logicalW).toBeCloseTo(d.physicalH / d.logicalH, 1);
    }
  });

  it('device names are unique and every category is in the display order', () => {
    const names = DEVICE_PRESETS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of DEVICE_PRESETS) expect(DEVICE_CATEGORY_ORDER).toContain(d.category);
  });

  it('includes the requested device families', () => {
    for (const n of [
      'iPhone Air', 'Galaxy S22', 'Galaxy Z Fold7 (Folded)', 'Galaxy Z Fold7 (Open)',
      'iPad Pro 11"', 'iPad Pro 13"', 'Xiaomi 14', 'Huawei Mate 60 Pro', 'Motorola Edge 50',
    ]) {
      expect(find(n)).toBeTruthy();
    }
  });

  it('iPhone 16 Pro and iPhone Air carry their real specs', () => {
    expect([find('iPhone 16 Pro').logicalW, find('iPhone 16 Pro').logicalH]).toEqual([402, 874]);
    expect([find('iPhone 16 Pro').physicalW, find('iPhone 16 Pro').physicalH]).toEqual([1206, 2622]);
    expect([find('iPhone Air').logicalW, find('iPhone Air').logicalH]).toEqual([420, 912]);
    expect(presetDpr(find('iPhone Air'))).toBe(3);
  });

  it('the folding phone has distinct folded vs open aspect ratios', () => {
    const folded = find('Galaxy Z Fold7 (Folded)');
    const open = find('Galaxy Z Fold7 (Open)');
    const aspect = (d: DevicePreset) => d.logicalW / d.logicalH;
    expect(aspect(folded)).toBeLessThan(0.55);  // tall + narrow cover
    expect(aspect(open)).toBeGreaterThan(0.8);   // near-square main panel
  });
});

describe('orientation + label', () => {
  it('resolveLogicalSize / resolvePhysicalSize swap w/h in landscape', () => {
    const p = find('iPhone 16 Pro');
    expect(resolveLogicalSize(p, 'portrait')).toEqual({ w: 402, h: 874 });
    expect(resolveLogicalSize(p, 'landscape')).toEqual({ w: 874, h: 402 });
    expect(resolvePhysicalSize(p, 'landscape')).toEqual({ w: 2622, h: 1206 });
  });

  it('presetLabel shows LOGICAL points and flips with orientation; Free has no suffix', () => {
    expect(presetLabel(find('iPhone 16 Pro'), 'portrait')).toBe('iPhone 16 Pro (402×874)');
    expect(presetLabel(find('iPhone 16 Pro'), 'landscape')).toBe('iPhone 16 Pro (874×402)');
    expect(presetLabel(FREE_PRESET)).toBe('Free');
  });
});

describe('filterDevices (picker search)', () => {
  it('returns everything for an empty query', () => {
    expect(filterDevices('')).toEqual(DEVICE_PRESETS);
    expect(filterDevices('   ')).toEqual(DEVICE_PRESETS);
  });

  it('matches by name, case-insensitively', () => {
    const r = filterDevices('iphone');
    expect(r.length).toBeGreaterThanOrEqual(3);
    expect(r.every((d) => d.name.toLowerCase().includes('iphone'))).toBe(true);
  });

  it('matches by category (e.g. "samsung", "apple")', () => {
    expect(filterDevices('samsung').every((d) => d.category === 'Samsung')).toBe(true);
    expect(filterDevices('apple').length).toBe(devices.filter((d) => d.category === 'Apple').length);
  });

  it('token-ANDs multiple terms', () => {
    const r = filterDevices('galaxy fold');
    expect(r.length).toBe(2); // folded + open
    expect(r.every((d) => d.name.toLowerCase().includes('fold'))).toBe(true);
  });

  it('returns empty for no match', () => {
    expect(filterDevices('nokia 3310')).toEqual([]);
  });
});
