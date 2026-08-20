/** getSafeAreaInsets — the measured safe-area insets game LAYOUT ARITHMETIC reads (#273).
 *
 *  The load-bearing property is WHERE it measures: inside the UI root's cascade, so an
 *  editor device preview's simulated `--ui-sa-*` reaches it. A probe on document.body
 *  would read a confident, wrong 0 in every preview — that is the bug this file exists to
 *  make impossible, and the reason the happy-path test alone would not be enough.
 *
 *  ⚠️ **jsdom does not substitute `var()` into a property**, so these tests exercise the
 *  module's var-reading branch, NOT the padding probe a real browser resolves. The live
 *  path is covered by MEASUREMENT instead, and that measurement is the evidence of
 *  record: an iPhone Air over the device lease reports top 68 / bottom 34, and an editor
 *  device preview on the same preset resolves the same 68 through `--ui-sa-top`. What
 *  these tests can and do pin is everything around it — inheritance from an ancestor
 *  (the property the whole design turns on), the zero defaults, cache invalidation, and
 *  that the probe leaves no trace in the DOM. */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSafeAreaInsets, measureSafeAreaInsets, resetSafeAreaInsets } from '../../src/runtime/ui/safeArea';

let root: HTMLElement;

beforeEach(() => {
  resetSafeAreaInsets();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
  resetSafeAreaInsets();
});

describe('getSafeAreaInsets', () => {
  it('is zeros before anything has measured — a game with no UI layer, or a headless test', () => {
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('reads the --ui-sa-* vars set on the UI root (the editor device-preview path)', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    root.style.setProperty('--ui-sa-bottom', '34px');
    root.style.setProperty('--ui-sa-left', '7px');
    root.style.setProperty('--ui-sa-right', '13px');
    measureSafeAreaInsets(root);
    // The measured iPhone Air quartet, with asymmetric sides so a swapped edge fails.
    expect(getSafeAreaInsets()).toMatchObject({ top: 68, right: 13, bottom: 34, left: 7 });
  });

  it('inherits vars set on an ANCESTOR — the editor sets them on the preview frame, not the UI root', () => {
    const frame = document.createElement('div');
    frame.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(frame);
    const inner = document.createElement('div');
    frame.appendChild(inner);
    measureSafeAreaInsets(inner);
    expect(getSafeAreaInsets().top).toBe(44);
    frame.remove();
  });

  it('falls back to zero when the var is unset and env() resolves to nothing (desktop / jsdom)', () => {
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  // The percentages are the field games should actually use, and they exist because the px
  // alone invite a wrong denominator: a game dividing by its own `getBoundingClientRect`
  // height mixes a PRE-transform inset with a POST-transform box, which is exactly how
  // Court's banner lifted 6.09% where 3.73% was right — correct on the phone, wrong in the
  // editor preview. These are measured against the root's layout box in the same pass.
  it('reports each inset as a percentage of the ROOT box, measured in the same pass', () => {
    Object.defineProperty(root, 'clientHeight', { value: 912, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 420, configurable: true });
    root.style.setProperty('--ui-sa-top', '68px');
    root.style.setProperty('--ui-sa-bottom', '34px');
    root.style.setProperty('--ui-sa-left', '21px');
    measureSafeAreaInsets(root);
    const i = getSafeAreaInsets();
    expect(i.topPct).toBeCloseTo((68 / 912) * 100, 9);
    expect(i.bottomPct).toBeCloseTo((34 / 912) * 100, 9);
    expect(i.leftPct).toBeCloseTo((21 / 420) * 100, 9);   // horizontal is a share of WIDTH
  });

  it('percentages are zero rather than Infinity when the root has no box yet', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    expect(getSafeAreaInsets().topPct).toBe(0);
  });

  it('a null root yields zeros rather than throwing — the UI layer may not be mounted', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    measureSafeAreaInsets(null);
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('leaves no probe behind in the DOM', () => {
    const before = document.body.querySelectorAll('*').length;
    measureSafeAreaInsets(root);
    expect(document.body.querySelectorAll('*').length).toBe(before);
  });

  it('re-measures rather than caching a stale value when the preset changes', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    root.style.setProperty('--ui-sa-top', '0px');   // e.g. switching to a device with no notch
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(0);
  });
});
