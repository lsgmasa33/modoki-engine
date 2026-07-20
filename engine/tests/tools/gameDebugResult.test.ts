/** Unit: result shaping for the game-debug MCP server (docs/mcp-response-budget.md Phase 7).
 *
 *  This server had NO tests. Two flooders lived in it:
 *   - `device_screenshot` inlined a full-resolution base64 image even when `savePath` was given —
 *     it wrote the file, opened Preview, and returned the blob anyway.
 *   - `device_eval` pretty-printed an arbitrary expression result with no cap, so
 *     `device_eval('document')` dumped the DOM into the transcript.
 *
 *  (`device_console_logs` / `device_native_logs` already default to limit:50 — they were never the
 *  problem, contrary to the audit that prompted this work.) */

import { describe, it, expect } from 'vitest';
import { encodeEvalResult, encodeStructuredResult, capText, extFor, describeScreenshot, MAX_TEXT_CHARS } from '../../tools/game-debug-mcp/src/result';

describe('encodeEvalResult', () => {
  it('emits compact JSON, not pretty-printed', () => {
    expect(encodeEvalResult({ w: 390, h: 844 })).toBe('{"w":390,"h":844}');
  });

  it('reports nullish as "undefined" (the old behavior)', () => {
    expect(encodeEvalResult(null)).toBe('undefined');
    expect(encodeEvalResult(undefined)).toBe('undefined');
  });

  it('passes a string through without JSON quotes', () => {
    expect(encodeEvalResult('hello')).toBe('hello');
  });

  it('caps a huge result instead of flooding the transcript', () => {
    const out = encodeEvalResult({ blob: 'x'.repeat(MAX_TEXT_CHARS * 2) });
    expect(out.length).toBeLessThan(MAX_TEXT_CHARS + 200);
    expect(out).toContain('chars elided of');
  });

  it('caps a huge STRING result too', () => {
    expect(encodeEvalResult('y'.repeat(MAX_TEXT_CHARS + 500))).toContain('500 chars elided');
  });

  it('survives a circular structure — device_eval("window") must not crash the tool', () => {
    const circular: Record<string, unknown> = { name: 'window' };
    circular.self = circular;
    const out = encodeEvalResult(circular);
    expect(out).toContain('unserializable eval result');
    expect(out).toContain('return a projection instead'); // tells the caller what to do next
  });

  it('survives a BigInt (JSON.stringify throws on it)', () => {
    expect(encodeEvalResult({ n: BigInt(1) })).toContain('unserializable eval result');
  });
});

describe('encodeStructuredResult', () => {
  it('pretty-prints a Percept object (scene-state / diagnose)', () => {
    const out = encodeStructuredResult({ entityCount: 2, entities: [{ id: 1, guid: 'g' }] });
    expect(out).toContain('"entityCount": 2'); // pretty (2-space), unlike encodeEvalResult
    expect(JSON.parse(out)).toEqual({ entityCount: 2, entities: [{ id: 1, guid: 'g' }] });
  });

  it('passes a bare string reply through unquoted', () => {
    expect(encodeStructuredResult('ok')).toBe('ok');
  });

  it('caps a huge structured result at the backstop', () => {
    const out = encodeStructuredResult({ blob: 'x'.repeat(MAX_TEXT_CHARS * 2) });
    expect(out.length).toBeLessThan(MAX_TEXT_CHARS + 200);
    expect(out).toContain('chars elided of');
  });

  it('does not crash on an unserializable result', () => {
    expect(encodeStructuredResult({ n: BigInt(1) })).toContain('unserializable result');
  });
});

describe('capText', () => {
  it('leaves an under-cap string alone', () => expect(capText('short', 100)).toBe('short'));
  it('reports the elided count', () => expect(capText('x'.repeat(150), 100)).toContain('50 chars elided of 150'));
  it('caps at the exact <= edge', () => {
    expect(capText('x'.repeat(100), 100)).toHaveLength(100);
    expect(capText('x'.repeat(101), 100)).toContain('1 chars elided');
  });
});

describe('extFor', () => {
  it('maps the mime types the bridge actually returns', () => {
    expect(extFor('image/jpeg')).toBe('jpg');
    expect(extFor('image/png')).toBe('png');
  });
});

describe('describeScreenshot', () => {
  it('reports path + size and says how to get the image inlined', () => {
    const s = describeScreenshot('[iOS] 1800x3900 (from 1260x2730).', '/tmp/shot.png', 3_145_728);
    expect(s).toContain('/tmp/shot.png');
    expect(s).toContain('3072 KB');
    expect(s).toContain('inline:true');
    // The coordinate contract must survive: the caller aims device_tap off these dimensions.
    expect(s).toContain('1800x3900');
  });
});
