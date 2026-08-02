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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeEvalResult, encodeStructuredResult, capText, extFor, describeScreenshot, MAX_TEXT_CHARS,
  isFailureBody, deviceFail, caughtFailure, deviceReplyFailure, ERROR_CODES,
} from '../../tools/game-debug-mcp/src/result';

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
  it('encodes a Percept object COMPACTLY (scene-state / diagnose)', () => {
    // This test previously asserted PRETTY-printing (`'"entityCount": 2'`, 2-space indent) — it was
    // pinning the divergence, not a requirement. MCP ships `content[].text` opaquely and the model
    // reads compact JSON identically, so the indentation was ~40% pure overhead on every device
    // Percept response. The editor server has always been compact; both now share one encoder
    // (`engine/tools/shared/mcpResult.ts`, conventions §9).
    const out = encodeStructuredResult({ entityCount: 2, entities: [{ id: 1, guid: 'g' }] });
    expect(out).toBe('{"entityCount":2,"entities":[{"id":1,"guid":"g"}]}');
    expect(JSON.parse(out)).toEqual({ entityCount: 2, entities: [{ id: 1, guid: 'g' }] });
  });

  it('passes a bare string reply through unquoted', () => {
    expect(encodeStructuredResult('ok')).toBe('ok');
  });

  it('over the cap, emits a VALID JSON envelope rather than a severed blob', () => {
    // Also previously wrong: it asserted `'chars elided of'`, the plain-TEXT truncation marker,
    // which meant structured JSON was being cut at N characters. A blob severed mid-object is
    // unparseable garbage to `JSON.parse` AND to the model — the failure the `{elided:true}`
    // envelope exists to prevent. NEVER MID-SLICE JSON.
    const out = encodeStructuredResult({ blob: 'x'.repeat(MAX_TEXT_CHARS * 2) });
    expect(out.length).toBeLessThan(MAX_TEXT_CHARS + 2000);
    const parsed = JSON.parse(out); // the point: it still parses
    expect(parsed.elided).toBe(true);
    expect(parsed.bytes).toBeGreaterThan(MAX_TEXT_CHARS);
    expect(parsed.hint).toMatch(/Narrow it/);
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

describe('perceptCall shares the editor server\'s C7 failure check (conventions §9)', () => {
  // The device server had NO isFailureBody equivalent, so a reply answering `{ok:false, error}` —
  // "the op did not happen" — was reported to the agent as a SUCCESSFUL tool call across all six
  // device Percept tools. Same class the editor side fixed in the C7 audit, silently unfixed here.
  // These assert the SHARED helper, which is now the one both servers call.
  it('flags a 200-shaped {ok:false} reply as a failure', () => {
    expect(isFailureBody({ ok: false, error: 'no scene loaded' })).toContain('no scene loaded');
    expect(isFailureBody({ ok: false, errors: ['stale guid', 'no renderer'] })).toContain('stale guid; no renderer');
  });

  it('does NOT flag a legitimate negative answer', () => {
    // `diagnose`-shaped replies report findings in `warnings`; an explicit ok:true is the route's
    // own verdict and wins over a non-empty errors[] (documented partial success, e.g. reimport).
    expect(isFailureBody({ ok: true, warnings: ['3 entities off-screen'] })).toBeNull();
    expect(isFailureBody({ ok: true, errors: ['one asset failed'] })).toBeNull();
    expect(isFailureBody({ entityCount: 0, entities: [] })).toBeNull();
  });
});

describe('§5 error envelope — the device server', () => {
  const env = (r: { content: Array<{ text: string }>; isError?: boolean }) => {
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text) as { error: { code: string; tool?: string; what: string; why: string; options?: string[] } };
    expect(parsed.error).toBeDefined();
    return parsed.error;
  };

  // Every device tool used to end in `catch (e) { text: `Error: ${e.message}` }` — literally the
  // "it didn't work" shape the audit exists to remove. The message that mattered most ("no device
  // connected — connect in the AI panel") was in there, flattened to the same anonymous prose as a
  // wedged socket, with no code to branch on and no next move named.
  it('a missing device lease is NOT_AVAILABLE_HERE, and says how the HUMAN connects one', () => {
    const e = env(caughtFailure('device_tap', 'tap the device screen',
      new Error('no device connected (state: idle) — connect in the AI panel first')));
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    expect(e.tool).toBe('device_tap');
    expect(e.options?.join(' ')).toContain('Connect a Device');
    expect(e.options?.join(' ')).toContain('device_status');
  });

  it('an unreachable BACKEND is a different failure from a missing DEVICE', () => {
    const e = env(caughtFailure('device_status', 'read the lease',
      new Error("Can't reach the Modoki backend at http://127.0.0.1:5181 — is the editor running for this clone?")));
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    // The remedy is the opposite one: start the EDITOR, not connect a device.
    expect(e.options?.join(' ')).toContain('launch-editor.sh');
    expect(e.options?.join(' ')).not.toContain('Connect a Device');
  });

  it('an unclassified transport error still names the tool and offers a next move', () => {
    const e = env(caughtFailure('device_eval', 'evaluate JS', new Error('socket hang up')));
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    expect(e.why).toContain('socket hang up');
    expect(e.options?.length).toBeGreaterThan(0);
  });

  it('a device `Error: …` REPLY is REFUSED_BY_OP — the op declined, the transport was fine', () => {
    const e = env(deviceReplyFailure('device_tap', 'tap selector "#play"', 'Error: element is occluded'));
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.why).toContain('occluded');
  });

  it('every code it emits is in the CLOSED set', () => {
    for (const r of [
      caughtFailure('device_tap', 'w', new Error('no device connected')),
      caughtFailure('device_tap', 'w', new Error("Can't reach the Modoki backend at x")),
      caughtFailure('device_tap', 'w', new Error('other')),
      deviceReplyFailure('device_tap', 'w', 'Error: nope'),
      deviceFail({ code: 'TIMEOUT', tool: 'device_tap', what: 'w', why: 'y' }),
    ]) expect(ERROR_CODES).toContain(env(r).code as never);
  });

  it('screenshot dims never reach a tap/drag WITHOUT the lease check (stale-scale guard)', () => {
    // `adbScreenInfo` converts screenshot pixels to device pixels. It was invalidated only by
    // taking another screenshot, so a lease that changed in between — the human reconnecting to a
    // different phone in the AI panel — left the PREVIOUS device's dimensions in place and a
    // coordinate tap was scaled by the wrong ratio: it landed elsewhere and reported success.
    // `currentScreenInfo()` re-checks the lease before handing them out.
    //
    // A source guard, kept as a cheap belt to the braces. The behavioural coverage it used to
    // stand in for now exists: `deviceToolSurface.test.ts` calls these handlers for real against a
    // stub backend (the Phase-8 gap this comment used to describe is closed).
    const src = readFileSync(join(__dirname, '../../tools/game-debug-mcp/src/mcp-tools.ts'), 'utf8');
    expect(src).toContain('async function currentScreenInfo');
    // The raw variable must never be spread into an outgoing request — only the checked accessor.
    expect(src).not.toMatch(/screenInfo:\s*adbScreenInfo/);
  });

  it('no device tool hand-rolls an anonymous `Error: <message>` result any more', () => {
    // A source guard: it stops a NEW tool from reintroducing the shape anywhere in the file, which
    // a per-tool behavioural test cannot do. `deviceToolSurface.test.ts` covers the behaviour.
    const src = readFileSync(join(__dirname, '../../tools/game-debug-mcp/src/mcp-tools.ts'), 'utf8');
    expect(src.length).toBeGreaterThan(1000);          // the guard must have a real target
    expect(src).not.toContain('text: `Error: ${(e as Error).message}`');
    // …and every failure goes through one of the three sanctioned constructors.
    const handRolled = src.match(/isError: true/g) ?? [];
    expect(handRolled, 'construct failures with deviceFail / caughtFailure / deviceReplyFailure').toEqual([]);
  });
});
