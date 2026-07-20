import { describe, it, expect } from 'vitest';
import { isFailureBody } from '../../tools/modoki-mcp/src/result';

/**
 * C7 — the systemic honesty fix.
 *
 * The MCP client only failed on `status >= 400`. Our routes answer "I refused / nothing
 * matched" with HTTP 200 + `{ok:false, errors:[…]}` — so Claude saw a SUCCESSFUL tool call
 * with the bad news buried in a JSON field. The C7 audit found that shape everywhere:
 * scene-mutate changing nothing, persistAsset when the disk write was REJECTED, save_all on
 * cancel, build on stale content. An agent that can't see a failure builds on it.
 *
 * The counter-risk this pins: `ok` must be a success FLAG, never an answer — a tool whose
 * legitimate result is negative (validate_scene) must NOT be turned into an error.
 */
describe('isFailureBody', () => {
  it('ok:false is a FAILURE (scene-mutate that changed nothing)', () => {
    const msg = isFailureBody({ ok: false, changed: 0, errors: ['op[0]: no entity matching {"guid":"x"} in this scene FILE'] });
    expect(msg).toMatch(/no entity matching/);
  });

  it('keeps the whole body — the scene-mutate `hint` is the actionable part', () => {
    const msg = isFailureBody({ ok: false, changed: 0, errors: ['nope'], hint: 'Run modoki_save_all, then retry.' });
    expect(msg).toMatch(/Run modoki_save_all/);
  });

  it('a non-empty errors[] fails even when ok is absent', () => {
    expect(isFailureBody({ changed: 0, errors: ['boom'] })).toMatch(/boom/);
  });

  it('an EXPLICIT ok:true WINS over errors[] — a PARTIAL reimport is a success', () => {
    // /api/reimport answers 200 {converted, skipped, errors} on partial success (500 only
    // when NOTHING converted): its errors[] NAMES the assets that failed while N others were
    // re-baked. Failing the call reported a successful 20-of-21 bake as a failed tool call.
    // The first C7 pass verified "ok is a success flag" but keyed off THREE fields — the
    // invariant was asserted over a narrower surface than the code enforced.
    expect(isFailureBody({ ok: true, converted: 20, skipped: 3, errors: ['/a.png: toktx exited 1'] })).toBeNull();
  });

  it('ok:false still fails even alongside progress (nothing converted)', () => {
    expect(isFailureBody({ ok: false, converted: 0, errors: ['/a.png: toktx exited 1'] })).toMatch(/toktx/);
  });

  it('an {error} string fails', () => {
    expect(isFailureBody({ error: 'path is required' })).toMatch(/path is required/);
  });

  it('ok:false with no detail still fails, with a usable message', () => {
    expect(isFailureBody({ ok: false })).toMatch(/ok:false/);
  });

  it('ok:true is NOT a failure', () => {
    expect(isFailureBody({ ok: true, changed: 1, errors: [], warnings: [] })).toBeNull();
  });

  it('WARNINGS are not failures — validate_scene reports findings there and must stay OK', () => {
    // The counter-risk: turning a legitimate negative RESULT into a tool error.
    expect(isFailureBody({ path: '/s.json', schemaApplied: true, warnings: ['unknown trait Foo'] })).toBeNull();
  });

  it('a body with no success flag at all is not a failure (plain data)', () => {
    expect(isFailureBody({ entities: [], entityCount: 0 })).toBeNull();
  });

  it('non-objects and null are not failures', () => {
    for (const v of [null, undefined, 'text', 42, [1, 2]]) expect(isFailureBody(v)).toBeNull();
  });

  it('a non-string errors[] entry cannot fabricate a failure', () => {
    expect(isFailureBody({ errors: [] })).toBeNull();
    expect(isFailureBody({ ok: true, errors: [{}] })).toBeNull();
  });
});
