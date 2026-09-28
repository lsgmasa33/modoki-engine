/** The agent `prefab apply` op's target check (#1693) — `checkApplyTargets`, pure data. It must say what `planApply`
 *  does with the same request, or the op validates one prefab and the Apply writes another (final close-out review).
 *  Each case names the mutation that turns it red. */

import { describe, it, expect } from 'vitest';
import { checkApplyTargets, type KeyTargets } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';

const O = 'outer-guid';
const P = 'inner-guid';
const opt = (target: string, name: string) => ({ target, name });
/** A key of the opened instance O's own frame, and a U14 key of its nested P frame (`frameTarget` P). */
const options = new Map<string, KeyTargets>([
  ['own.T.f', { options: [opt(O, 'O')], defaultTarget: O, frameTarget: O }],
  ['gN:gA.T.f', { options: [opt(O, 'O'), opt(P, 'P')], defaultTarget: O, frameTarget: P }],
  ['-removed.gN:gA', { options: [opt(O, 'O')], defaultTarget: O, frameTarget: P }],
]);
/** Two spellings of one key: a guid ref and a localId ref (`canonicalOverrideKey`'s job, stood in for here). */
const canonical = (k: string) => k.replace('4:2', 'gN:gA');
const check = (keys: string[], asked: { default?: string; perKey?: Record<string, string> }) =>
  checkApplyTargets(keys, options, O, asked, canonical, () => undefined);

describe('checkApplyTargets', () => {
  it('two spellings of one key asking for two targets are refused, not resolved by order', () => {
    // Mutation: build the per-key map with \`new Map(entries)\` (last one wins) — the request is accepted, applied to O.
    expect(check(['4:2.T.f'], { perKey: { '4:2.T.f': P, 'gN:gA.T.f': O } }).bad).toHaveLength(1);
  });

  it("'frame' on a nested key is the NESTED frame's prefab, as the Apply writes it; 'instance' the opened one's", () => {
    // Mutation: read 'frame' as `ownSource` — P is refused although the Apply would write it.
    expect(check(['gN:gA.T.f'], { default: 'frame' }).bad).toEqual([]);
    expect(check(['gN:gA.T.f'], { default: 'instance' }).bad).toEqual([]);
    // 'instance' on a key only the opened prefab can take is O, whatever the key's frame.
    // Mutation: read 'instance' as the key's `frameTarget` — the removal below is refused.
    expect(check(['-removed.gN:gA'], { default: 'instance' }).bad).toEqual([]);
    // …and a nested member removal has no inner target, so 'frame' refuses it rather than applying part of the call.
    expect(check(['-removed.gN:gA'], { default: 'frame' }).bad).toHaveLength(1);
  });

  it('a per-key target spelled differently from its key is matched, checked, and handed on under the keys\' spelling', () => {
    // Mutation: look the target up by the exact key string — it is dropped, and the Apply falls back to the default.
    const r = check(['4:2.T.f'], { perKey: { 'gN:gA.T.f': P } });
    expect(r).toEqual({ perKey: { '4:2.T.f': P }, stray: [], bad: [] });
  });

  it('an unknown target and a target for a key not acted on are named, all-or-nothing', () => {
    // Mutation: never refuse (`if (!opts.some(…))` → `if (false)`) — the unknown target passes, and the Apply refuses it
    // only per key, after the rest landed.
    expect(check(['own.T.f', 'gN:gA.T.f'], { default: 'nope' }).bad).toHaveLength(2);
    expect(check(['own.T.f'], { perKey: { 'gN:gA.T.f': P } }).stray).toEqual(['gN:gA.T.f']);
  });
});
