/** Device preset data + search/orientation helpers. Guards the req-1 fix (logical
 *  resolution shown), catalog integrity (no bad entries — a wrong aspect silently
 *  mis-letterboxes every view), and the search/filter used by the device picker. */
import { describe, it, expect } from 'vitest';
import {
  DEVICE_PRESETS, FREE_PRESET, DEVICE_CATEGORY_ORDER, type DevicePreset,
  resolveLogicalSize, resolvePhysicalSize, presetDpr, presetLabel, filterDevices,
  resolveSafeArea, safeAreaCssVars,
  findPresetByName, makeCustomPreset, validateCustomSize, describeDeviceSelection,
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
      'Galaxy Tab S9', 'Galaxy Tab S9+', 'Pixel Tablet',
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

  it('the Android tablets carry their real specs', () => {
    for (const [n, logical, physical] of [
      ['Galaxy Tab S9', [800, 1280], [1600, 2560]],
      ['Pixel Tablet', [800, 1280], [1600, 2560]],
      ['Galaxy Tab S9+', [876, 1400], [1752, 2800]],
    ] as const) {
      const p = find(n);
      expect([p.logicalW, p.logicalH], n).toEqual(logical);
      expect([p.physicalW, p.physicalH], n).toEqual(physical);
      expect(presetDpr(p), n).toBe(2);
    }
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

  /** The Android presets that are TABLETS. An explicit list, not a property read off the preset:
   *  deriving "is a tablet" from its own safe-area quartet would make the guard below assert the
   *  data it is guarding. A new Android preset therefore defaults into the phone set and is held to
   *  the 28pt cutout — which is the right default, and a tablet added without a line here fails
   *  loudly rather than passing silently. */
  const ANDROID_TABLETS = ['Galaxy Tab S9', 'Galaxy Tab S9+', 'Pixel Tablet'];

  // MEASURED on TWO handsets that agree within 1dp: Galaxy A23 -> env() top 28, Galaxy S22 -> 27,
  // both bottom 0 (Court hides both system bars). Bottom-of-screen chrome therefore sits flush on
  // Android while it lifts 34pt on a home-indicator iPhone — the asymmetry is real, not an
  // oversight, and a symmetric "24/24" guess got it wrong on both edges at once.
  it('Android presets carry the cutout on top and nothing at the bottom', () => {
    const android = DEVICE_PRESETS.filter((p) => ['Samsung', 'Google', 'Android'].includes(p.category));
    const phones = android.filter((p) => !ANDROID_TABLETS.includes(p.name));
    const tablets = android.filter((p) => ANDROID_TABLETS.includes(p.name));
    expect(phones.length).toBeGreaterThan(4);
    // ⚠️ NOT `phones.length + tablets.length === android.length` — that was here and it is
    // VACUOUS: the two filters are complementary predicates over one array, so the sum equals
    // `android.length` for every possible catalog and every possible ANDROID_TABLETS. What
    // actually catches a stale list is the `top === 28` loop below (a tablet that fell into
    // `phones`) plus this, which catches the other direction: a name here with no row behind it.
    for (const n of ANDROID_TABLETS) {
      expect(tablets.some((p) => p.name === n), `${n} is in ANDROID_TABLETS but not in the catalog`).toBe(true);
    }
    for (const p of phones) {
      const portrait = resolveSafeArea(p, 'portrait');
      expect(portrait.top, `${p.name} top`).toBe(28);
      expect(portrait.bottom, `${p.name} bottom — both bars are hidden`).toBe(0);
      expect(portrait.left + portrait.right, `${p.name} sides`).toBe(0);
    }
  });

  // REASONED, not measured — no ANDROID tablet is attached to this machine (an iPad mini 5 is,
  // and it is what pins `faceIdIPad`). All three put the camera in the
  // bezel (no cutout) and hide both system bars (nothing at the bottom), so all four edges are 0 in
  // both orientations. Replace with a real quartet the first time a tablet is on hand to measure.
  it('the Android tablets have no insets in either orientation — reasoned, not measured', () => {
    for (const name of ANDROID_TABLETS) {
      const p = find(name);
      for (const o of ['portrait', 'landscape'] as const) {
        expect(resolveSafeArea(p, o), `${name} ${o}`).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
      }
    }
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

/** The agent-facing resolution behind `modoki_set_game_view_device` (#367). These are the decisions
 *  the op makes — kept in the module so they are testable without an editor, and tested here
 *  because the failure they guard against is silent: previewing a DIFFERENT screen than the one
 *  asked for makes every measurement taken afterwards wrong, with nothing to indicate it. */
describe('agent device resolution (#367)', () => {
  it('resolves a preset by name, case-insensitively', () => {
    expect(findPresetByName('iPhone 16 Pro')?.name).toBe('iPhone 16 Pro');
    expect(findPresetByName('iphone 16 pro')?.name).toBe('iPhone 16 Pro');
    expect(findPresetByName('  Free  ')?.name).toBe('Free');
  });

  it('returns undefined for a near miss rather than the nearest match', () => {
    // The whole point of refusing: 'iPhone 16 Pr' must NOT resolve to 'iPhone 16 Pro'.
    expect(findPresetByName('iPhone 16 Pr')).toBeUndefined();
    expect(findPresetByName('iPhone')).toBeUndefined();
    expect(findPresetByName('')).toBeUndefined();
  });

  it('no two presets differ only by case — which is what makes the lookup unambiguous', () => {
    const lower = DEVICE_PRESETS.map((p) => p.name.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('a custom preset derives physical from logical x dpr, and defaults dpr to 1', () => {
    expect(makeCustomPreset(640, 480)).toMatchObject({ logicalW: 640, logicalH: 480, physicalW: 640, physicalH: 480 });
    expect(makeCustomPreset(640, 480, 2)).toMatchObject({ physicalW: 1280, physicalH: 960 });
    expect(presetDpr(makeCustomPreset(400, 800, 3))).toBeCloseTo(3);
  });

  it('a custom preset carries NO safe-area insets, in both orientations', () => {
    const c = makeCustomPreset(640, 480);
    for (const o of ['portrait', 'landscape'] as const) {
      expect(resolveSafeArea(c, o)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    }
  });

  it('rejects a zero dimension — 0 is how Free says "fill the panel"', () => {
    // The sharpest case here: without this, {logicalWidth: 0} would silently become Free and
    // report success, and a caller would attribute a full-panel measurement to a 0-wide screen.
    expect(validateCustomSize(0, 480, undefined)).toMatch(/Free/);
    expect(validateCustomSize(640, 0, undefined)).toMatch(/between/);
  });

  it('rejects non-integer, non-finite and out-of-range sizes, naming the offending param', () => {
    expect(validateCustomSize(640.5, 480, undefined)).toMatch(/logicalWidth.*whole number/);
    expect(validateCustomSize(NaN, 480, undefined)).toMatch(/logicalWidth.*finite/);
    expect(validateCustomSize(640, undefined, undefined)).toMatch(/logicalHeight.*finite/);
    expect(validateCustomSize(99999, 480, undefined)).toMatch(/logicalWidth.*8192/);
  });

  it('accepts a usable size, and bounds dpr', () => {
    expect(validateCustomSize(640, 480, undefined)).toBeNull();
    expect(validateCustomSize(640, 480, 0.5)).toBeNull();
    expect(validateCustomSize(8192, 8192, 4)).toBeNull();
    expect(validateCustomSize(640, 480, 0)).toMatch(/dpr.*between/);
    expect(validateCustomSize(640, 480, 8)).toMatch(/dpr.*between/);
  });

  it('refuses a dpr that cannot ROUND-TRIP, rather than silently rounding it away', () => {
    // The read-back recovers dpr as physical/logical, and physical is rounded — so `{1,1,0.5}`
    // used to be accepted and answer `dpr: 1`, and `{3,3,0.5}` answered 0.666…, both contradicting
    // the call. Telling the agent a dpr it did not ask for is worse than refusing the combination.
    expect(validateCustomSize(1, 1, 0.5)).toMatch(/fractional physical size/);
    expect(validateCustomSize(3, 3, 0.5)).toMatch(/fractional physical size/);
    // The refusal names the offending dimension, so the caller knows which one to change.
    expect(validateCustomSize(640, 481, 0.5)).toMatch(/logicalHeight/);
    // A dpr that DOES round-trip on both axes stays accepted — this is a round-trip guard, not a
    // ban on fractional dpr (real devices have them: Pixel 9 is ~2.62).
    expect(validateCustomSize(400, 800, 2.5)).toBeNull();
  });

  it('every accepted custom size reports back the dpr it was given', () => {
    // The property the refusal above exists to protect, asserted end-to-end rather than trusted.
    for (const [w, h, dpr] of [[640, 480, 1], [640, 480, 0.5], [400, 800, 2.5], [402, 874, 3]] as const) {
      expect(validateCustomSize(w, h, dpr), `${w}x${h}@${dpr} should be accepted`).toBeNull();
      expect(presetDpr(makeCustomPreset(w, h, dpr)), `${w}x${h}@${dpr} must round-trip`).toBeCloseTo(dpr, 9);
    }
  });

  it('describes a preset selection with the orientation applied', () => {
    const p = find('iPhone 16 Pro');
    const portrait = describeDeviceSelection(p, 'portrait');
    const landscape = describeDeviceSelection(p, 'landscape');
    expect(portrait.logical).toEqual({ w: p.logicalW, h: p.logicalH });
    // Landscape is a FLIP of the size...
    expect(landscape.logical).toEqual({ w: p.logicalH, h: p.logicalW });
    expect(landscape.physical).toEqual({ w: p.physicalH, h: p.physicalW });
    // ...but a LOOKUP for the insets: rotating the portrait quartet would invent a top inset
    // this device does not have in landscape. See SafeAreaSet's docblock.
    expect(portrait.safeArea.top).toBeGreaterThan(0);
    expect(landscape.safeArea.top).toBe(0);
    expect(portrait.free).toBe(false);
  });

  it("distinguishes a preset's authored zeros from a custom size's zeros-by-construction", () => {
    // Four bare zeros are indistinguishable from a measurement, which is why the basis is
    // reported: an iPhone SE really DOES report 0 with the status bar hidden, while a custom
    // size has no device to look anything up from.
    expect(describeDeviceSelection(find('iPhone SE'), 'portrait')).toMatchObject({
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, safeAreaBasis: 'preset',
    });
    expect(describeDeviceSelection(makeCustomPreset(640, 480), 'portrait').safeAreaBasis).toBe('custom-none');
  });

  it('marks Free as free, with no fixed size', () => {
    const d = describeDeviceSelection(FREE_PRESET, 'portrait');
    expect(d).toMatchObject({ device: 'Free', free: true, logical: { w: 0, h: 0 }, dpr: 1 });
  });
});
