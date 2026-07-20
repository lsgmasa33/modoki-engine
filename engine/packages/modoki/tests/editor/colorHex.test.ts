/** Pure helpers behind the ColorField's copyable `#rrggbbaa` hex.
 *
 *  Two invariants carry real weight here:
 *   - the shorthand REJECTION (a live-committing input must not accept a 3-char buffer
 *     mid-typing, or `#aabbcc` commits a bogus `#aaaabb` at the third keystroke);
 *   - the 8-bit alpha quantization, which is why ColorField only writes alpha back when
 *     the byte changed — otherwise an authored 0.5 drifts to 0.502 on an RGB-only edit. */

import { describe, it, expect } from 'vitest';

const { colorToHex, rgbaToHex, parseHexColor, alphaToByte, normalizeColor } =
  await import('../../src/editor/panels/assetViews/widgets');

describe('rgbaToHex', () => {
  it('appends the alpha byte in CSS #rrggbbaa order', () => {
    expect(rgbaToHex(0xaabbcc, 1)).toBe('#aabbccff');
    expect(rgbaToHex(0xaabbcc, 0)).toBe('#aabbcc00');
  });
  it('zero-pads a single-digit alpha byte', () => {
    // 0.0667 * 255 = 17 = 0x11 — the user's own #aabbcc11
    expect(rgbaToHex(0xaabbcc, 17 / 255)).toBe('#aabbcc11');
  });
  it('clamps out-of-range alpha rather than emitting a 9th digit', () => {
    expect(rgbaToHex(0x000000, 4)).toBe('#000000ff');
    expect(rgbaToHex(0x000000, -1)).toBe('#00000000');
  });
  it('falls back to opaque on a non-finite alpha', () => {
    expect(rgbaToHex(0xffffff, NaN)).toBe('#ffffffff');
  });
  it('always returns exactly 9 chars', () => {
    for (const a of [0, 0.5, 1, NaN, -1, 2]) expect(rgbaToHex(0x123456, a)).toHaveLength(9);
  });
});

describe('parseHexColor', () => {
  it('parses 6-digit with and without the leading #', () => {
    expect(parseHexColor('#ff8000')).toEqual({ color: 0xff8000, alpha: null });
    expect(parseHexColor('ff8000')).toEqual({ color: 0xff8000, alpha: null });
  });
  it('parses 8-digit into color + alpha', () => {
    const p = parseHexColor('#aabbcc11');
    expect(p!.color).toBe(0xaabbcc);
    expect(p!.alpha).toBeCloseTo(17 / 255, 6);
  });
  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseHexColor('  #AABBCC  ')).toEqual({ color: 0xaabbcc, alpha: null });
    expect(parseHexColor('#FfFfFfFf')!.alpha).toBe(1);
  });
  it('REJECTS 3/4-digit shorthand — it would commit mid-typing', () => {
    // Typing '#aabbcc' passes through '#aab' (a valid CSS shorthand). Accepting it
    // would commit #aaaabb before the user finished. Paste is unaffected (6/8 chars).
    expect(parseHexColor('#aab')).toBeNull();
    expect(parseHexColor('#aabb')).toBeNull();
  });
  it('rejects partial, over-long, and non-hex input', () => {
    for (const bad of ['', '#', '#f', '#ff', '#fff00', '#ff8000f', '#ff8000ff0', '#gg8000', 'rgb(1,2,3)', '#ff 800'])
      expect(parseHexColor(bad)).toBeNull();
  });
  it('never returns a color outside 24 bits', () => {
    expect(parseHexColor('#ffffffff')!.color).toBe(0xffffff);
  });
});

describe('round-trip: format → parse', () => {
  it('preserves rgb exactly for every channel extreme', () => {
    for (const c of [0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0x123456])
      expect(parseHexColor(colorToHex(c))!.color).toBe(c);
  });
  it('preserves an alpha that is already byte-aligned', () => {
    for (const byte of [0, 17, 128, 254, 255]) {
      const a = byte / 255;
      expect(parseHexColor(rgbaToHex(0x808080, a))!.alpha).toBeCloseTo(a, 9);
    }
  });
  it('quantizes a non-byte-aligned alpha — the drift ColorField guards against', () => {
    const parsed = parseHexColor(rgbaToHex(0x808080, 0.5))!.alpha!;
    expect(parsed).not.toBe(0.5);          // 0.5 → 0x80 → 128/255
    expect(parsed).toBeCloseTo(0.502, 3);
    // ...but the BYTE is stable, which is the comparison ColorField actually makes,
    // so an RGB-only edit leaves the stored float untouched.
    expect(alphaToByte(parsed)).toBe(alphaToByte(0.5));
  });
});

describe('alphaToByte', () => {
  it('rounds to nearest and clamps to 0..255', () => {
    expect(alphaToByte(0)).toBe(0);
    expect(alphaToByte(1)).toBe(255);
    expect(alphaToByte(0.5)).toBe(128);
    expect(alphaToByte(-3)).toBe(0);
    expect(alphaToByte(3)).toBe(255);
  });
  it('treats a non-finite alpha as opaque', () => {
    expect(alphaToByte(NaN)).toBe(255);
  });
});

describe('normalizeColor', () => {
  it('masks, floors, and rescues non-finite values', () => {
    expect(normalizeColor(0x1ff8000)).toBe(0xff8000);
    expect(normalizeColor(0xff8000 + 0.8)).toBe(0xff8000);
    expect(normalizeColor(NaN)).toBe(0);
    expect(normalizeColor(-1)).toBe(0xffffff);
  });
});
