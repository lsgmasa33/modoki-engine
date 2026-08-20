/** Device preset data + search/orientation helpers. Guards the req-1 fix (logical
 *  resolution shown), catalog integrity (no bad entries — a wrong aspect silently
 *  mis-letterboxes every view), and the search/filter used by the device picker. */
import { describe, it, expect } from 'vitest';
import {
  DEVICE_PRESETS, FREE_PRESET, DEVICE_CATEGORY_ORDER, type DevicePreset,
  resolveLogicalSize, resolvePhysicalSize, presetDpr, presetLabel, filterDevices,
  resolveSafeArea, safeAreaCssVars,
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

/** Safe-area insets (#271). These are what lets an editor device preview show what a
 *  notched phone does — `env(safe-area-inset-*)` is 0 on every desktop browser, so
 *  without them the preview structurally cannot disagree with a wrong layout. */
describe('devicePresets — safe area', () => {
  it('every preset carries insets for both orientations', () => {
    for (const p of DEVICE_PRESETS) {
      for (const o of ['portrait', 'landscape'] as const) {
        const i = resolveSafeArea(p, o);
        for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
          expect(Number.isFinite(i[edge]), `${p.name} ${o}.${edge}`).toBe(true);
          expect(i[edge], `${p.name} ${o}.${edge}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('Free and the abstract aspect presets have no insets — they are not devices', () => {
    const abstract = [FREE_PRESET, ...DEVICE_PRESETS.filter((p) => p.category === 'Aspect')];
    for (const p of abstract) {
      for (const o of ['portrait', 'landscape'] as const) {
        expect(resolveSafeArea(p, o), p.name).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
      }
    }
  });

  // The bug this forbids: reusing resolveLogicalSize's w/h swap for the insets. That
  // gives a landscape iPhone a 62pt TOP inset it does not have, and drops the side
  // insets it does — every element on the notch side would be authored wrong while the
  // preview looked confident.
  it('landscape is NOT a rotation of portrait — the notch moves to the sides', () => {
    const air = find('iPhone Air');
    const portrait = resolveSafeArea(air, 'portrait');
    const landscape = resolveSafeArea(air, 'landscape');
    expect(portrait.top).toBeGreaterThan(0);
    expect(portrait.left).toBe(0);
    expect(portrait.right).toBe(0);
    expect(landscape.top).toBe(0);
    expect(landscape.left).toBe(portrait.top);
    expect(landscape.right).toBe(portrait.top);
    expect(landscape.bottom).toBeGreaterThan(0);
    expect(landscape.bottom).not.toBe(portrait.bottom);
  });

  // MEASURED on the hardware (2026-08-20), which is why it is pinned separately from the
  // published rows: 68 appears in no published table — the Air is neither the 59 of the
  // 16/16 Plus nor the 62 of the 16 Pro. A future "cleanup" to 62 would be a regression
  // against a real device, so it fails here.
  it('pins the MEASURED iPhone Air quartet (68/34, not the published 59 or 62)', () => {
    const p = find('iPhone Air');
    expect(resolveSafeArea(p, 'portrait')).toEqual({ top: 68, right: 0, bottom: 34, left: 0 });
  });

  it('pins the published iPhone 16 Pro quartet — the row the notched pattern was read off', () => {
    const p = find('iPhone 16 Pro');
    expect(resolveSafeArea(p, 'portrait')).toEqual({ top: 62, right: 0, bottom: 34, left: 0 });
    expect(resolveSafeArea(p, 'landscape')).toEqual({ top: 0, right: 62, bottom: 21, left: 62 });
  });

  // A home-button iPhone reports 0 with the status bar hidden — measured on the iPhone 8,
  // and the fact that disproved the first attempt at the #272 fix. If this ever becomes
  // non-zero, the model in the file header (PHYSICAL insets only) has drifted.
  it('a device with no notch and no home indicator has no insets', () => {
    expect(resolveSafeArea(find('iPhone SE'), 'portrait')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('safeAreaCssVars emits the four px vars anchorCss reads', () => {
    expect(safeAreaCssVars({ top: 62, right: 0, bottom: 34, left: 0 })).toEqual({
      '--ui-sa-top': '62px',
      '--ui-sa-right': '0px',
      '--ui-sa-bottom': '34px',
      '--ui-sa-left': '0px',
    });
  });

  // The var NAMES are a contract with anchorCss's `var(--ui-sa-*, env(...))`. A rename on
  // one side alone is invisible: the fallback still resolves, so the editor quietly stops
  // simulating anything and goes back to lying about the device.
  it('the var names match the ones anchorCss emits', async () => {
    const { applyAnchorStyle } = await import('../../src/runtime/ui/anchorCss');
    const style: Record<string, unknown> = {};
    applyAnchorStyle(style, {
      anchor: 'stretch', safeArea: true,
      top: 0, topUnit: 'px', right: 0, rightUnit: 'px',
      bottom: 0, bottomUnit: 'px', left: 0, leftUnit: 'px',
      pivotX: 0, pivotY: 0,
    });
    const css = JSON.stringify(style);
    for (const name of Object.keys(safeAreaCssVars({ top: 1, right: 1, bottom: 1, left: 1 }))) {
      expect(css, name).toContain(`var(${name},`);
    }
  });
});
