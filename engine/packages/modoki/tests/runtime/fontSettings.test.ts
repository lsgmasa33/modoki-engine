import { describe, it, expect } from 'vitest';
import { DEFAULT_FONT_SETTINGS, resolveFontSettings } from '../../src/runtime/core/fontSettings';

describe('resolveFontSettings', () => {
  it('fills defaults for missing/empty meta, including shipSource:"auto"', () => {
    expect(resolveFontSettings(undefined)).toEqual(DEFAULT_FONT_SETTINGS);
    expect(resolveFontSettings(null)).toEqual(DEFAULT_FONT_SETTINGS);
    expect(resolveFontSettings({})).toEqual(DEFAULT_FONT_SETTINGS);
    expect(resolveFontSettings({}).shipSource).toBe('auto');
  });

  it('a font block with no shipSource field still resolves to "auto"', () => {
    expect(resolveFontSettings({ font: { size: 64 } }).shipSource).toBe('auto');
  });

  it('honors an explicit "always" override', () => {
    expect(resolveFontSettings({ font: { shipSource: 'always' } }).shipSource).toBe('always');
  });

  it('honors an explicit "never" override', () => {
    expect(resolveFontSettings({ font: { shipSource: 'never' } }).shipSource).toBe('never');
  });

  it('merges shipSource alongside other overridden fields', () => {
    const resolved = resolveFontSettings({ font: { shipSource: 'always', size: 96, mode: 'dynamic' } });
    expect(resolved.shipSource).toBe('always');
    expect(resolved.size).toBe(96);
    expect(resolved.mode).toBe('dynamic');
    // Untouched fields keep the default.
    expect(resolved.pxRange).toBe(DEFAULT_FONT_SETTINGS.pxRange);
  });
});
