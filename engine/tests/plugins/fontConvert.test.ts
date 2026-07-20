/** Font conversion tests — exact msdf-atlas-gen flag vector, charset-file
 *  formatting, and the missing-CLI error. execFileSync is mocked so the CLI probe
 *  is deterministic regardless of whether msdf-atlas-gen is installed. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => {
  const err = Object.assign(new Error('spawn msdf-atlas-gen ENOENT'), { code: 'ENOENT' });
  const execFileSync = vi.fn(() => { throw err; });
  return { execFileSync, default: { execFileSync } };
});

import { buildAtlasGenArgs, buildCharsetFile, ensureMsdfAtlasGen, __resetMsdfCheck } from '../../plugins/font-convert';
import { DEFAULT_FONT_SETTINGS } from '../../packages/modoki/src/runtime/loaders/fontSettings';

const S = DEFAULT_FONT_SETTINGS;

describe('buildAtlasGenArgs', () => {
  it('emits mtsdf type, top y-origin, and the size/pxrange from settings', () => {
    const args = buildAtlasGenArgs(S, '/f.ttf', '/cs.txt', '/out.png', '/out.json');
    expect(args[args.indexOf('-type') + 1]).toBe('mtsdf');
    expect(args[args.indexOf('-yorigin') + 1]).toBe('top');
    expect(args[args.indexOf('-size') + 1]).toBe(String(S.size));
    expect(args[args.indexOf('-pxrange') + 1]).toBe(String(S.pxRange));
    expect(args[args.indexOf('-font') + 1]).toBe('/f.ttf');
    expect(args[args.indexOf('-charset') + 1]).toBe('/cs.txt');
    expect(args[args.indexOf('-imageout') + 1]).toBe('/out.png');
    expect(args[args.indexOf('-json') + 1]).toBe('/out.json');
    expect(args).toContain('-potr');
  });

  it('honors a non-default fieldType', () => {
    const args = buildAtlasGenArgs({ ...S, fieldType: 'msdf' }, 'f', 'c', 'o', 'j');
    expect(args[args.indexOf('-type') + 1]).toBe('msdf');
  });
});

describe('buildCharsetFile', () => {
  it('wraps the expanded charset in a double-quoted string', () => {
    const out = buildCharsetFile({ ...S, charset: 'custom', customChars: 'ABC' });
    expect(out).toBe('"ABC"');
  });

  it('escapes embedded double-quotes and backslashes', () => {
    const out = buildCharsetFile({ ...S, charset: 'custom', customChars: 'a"b\\c' });
    expect(out).toBe('"a\\"b\\\\c"');
  });

  it('ascii preset expands to the 95 printable characters', () => {
    const out = buildCharsetFile({ ...S, charset: 'ascii' });
    // strip the surrounding quotes; escaping only touches " and \ (2 chars → 4)
    const inner = out.slice(1, -1).replace(/\\(.)/g, '$1');
    expect(inner.length).toBe(0x7e - 0x20 + 1);
    expect(inner).toContain('A');
    expect(inner).toContain(' ');
  });
});

describe('ensureMsdfAtlasGen', () => {
  it('throws an install hint when the binary is missing (ENOENT)', () => {
    __resetMsdfCheck();
    expect(() => ensureMsdfAtlasGen()).toThrow(/msdf-atlas-gen not found/);
    // The install hint is platform-aware (brew on macOS, the win64 zip on Windows); assert the
    // GitHub project URL that BOTH branches carry rather than the macOS-only `brew` line.
    expect(() => ensureMsdfAtlasGen()).toThrow(/Chlumsky\/msdf-atlas-gen/);
  });
});
